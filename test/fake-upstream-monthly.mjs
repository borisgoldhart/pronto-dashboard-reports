// Stand-in for the reporting endpoint that returns REAL monthly interval buckets,
// so a dual-source widget can be tested for the thing most likely to go wrong:
// the two sources' buckets not lining up.
//
// Per entity the numbers are deterministic and distinguishable:
//   job                 -> count       = 10 + monthIndex   (split across 2 offices)
//   timesheet_user_data -> stats_sum   = 1000 * (monthIndex + 1)
//
// GET /__omit/:entity/:YYYY-MM  drops that month from that entity's response, which is
// what the real API does when a source has no rows in a window.
// GET /__reset clears omissions. GET /__hits returns per-entity request counts.
import express from "express";

const app = express();
const omitted = new Set();          // "entity|YYYY-MM"
const hits = {};

let short = null;                   // entity whose facet buckets don't account for every row
app.get("/__omit/:entity/:month", (q, r) => { omitted.add(`${q.params.entity}|${q.params.month}`); r.json({ ok: true, omitted: [...omitted] }); });
app.get("/__short/:entity", (q, r) => { short = q.params.entity; r.json({ ok: true, short }); });
app.get("/__reset", (_q, r) => { omitted.clear(); short = null; for (const k in hits) delete hits[k]; r.json({ ok: true }); });
app.get("/__hits", (_q, r) => r.json(hits));

/** "DD-MM-YYYY" -> Date (UTC). */
const parse = (s) => { const [d, m, y] = String(s).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

// --- Pronto user search (JSON:API), for the dashboard sharing picker ---------
// Reproduces the real endpoint's fussiness: it answers 406 unless the Accept
// header is application/vnd.api+json. That trap is the whole reason people.js
// sets it explicitly, so the mock has to enforce it or the test proves nothing.
const PEOPLE = [
  { userid: 685,    name: "Richard Smallwood", email: "richard.smallwood@pulse.ms", client: "Havas London (Agency)" },
  { userid: 991001, name: "Rich Tanner",       email: "rich.tanner@pulse.ms",       client: "Havas Life (Agency)" },
  { userid: 991002, name: "Dana Okoye",        email: "dana.okoye@pulse.ms",        client: "Arnold (Agency)" },
  { userid: 991003, name: "Priya Raman",       email: "priya.raman@pulse.ms",       client: "Havas Lynx New York (Agency)" },
];
app.get("/v2/api/users", (q, r) => {
  if (!String(q.headers.accept || "").includes("application/vnd.api+json")) {
    return r.status(406).json({ message: "The requested resource is capable of generating only content not acceptable according to the Accept headers sent in the request." });
  }
  const term = String(q.query["filter[search]"] || "").toLowerCase();
  const size = Number(q.query["page[size]"] || 10);
  const found = PEOPLE.filter((p) => !term || p.name.toLowerCase().includes(term) || p.email.toLowerCase().includes(term));
  r.json({
    meta: { page: { total: found.length } }, links: {},
    data: found.slice(0, size).map((p) => ({ type: "users", id: String(p.userid), attributes: { ...p, access: "active" } })),
  });
});

// --- brand scope, as the real index behaves -------------------------------------
// Two facts this has to reproduce or the tests prove nothing:
//   1. brand_id / brandcat_id are NUMERIC. A single id filters exactly; anything else
//      ("(5586 OR 10789)", "5586,10789", a range) is refused with HTTP 200 and the plain
//      text "Invalid Number: <value>". Verified live.
//   2. Filtering narrows the numbers, so a fan-out over several ids must ADD UP to the
//      same ids fetched one at a time — the property the merge depends on.
// Each id multiplies the month's numbers by a whole number, so that addition is exact.
// No filter -> factor 1, so every other test sees the numbers it always saw.
const BRAND_W = { 5586: 2, 10789: 3, 777: 5 };      // brand_id -> multiplier
const CAT_W = { 41: 4, 72: 6 };                      // brandcat_id -> multiplier
function scopeFilters(query) {
  // Express parses filter_fields[0][name] into a nested array; a plainer parser would
  // leave the flat keys. Both shapes are read so the mock doesn't depend on that.
  const ff = query.filter_fields;
  if (ff && typeof ff === "object") return Object.values(ff).filter(Boolean);
  const out = [];
  for (const k of Object.keys(query)) {
    const m = /^filter_fields\[(\d+)\]\[name\]$/.exec(k);
    if (m) out.push({ name: query[k], value: query[`filter_fields[${m[1]}][value]`] });
  }
  return out;
}
function scopeFactor(query) {
  let factor = 1;
  for (const f of scopeFilters(query)) {
    if (f.name !== "brand_id" && f.name !== "brandcat_id") continue;
    const value = String(f.value ?? "");
    if (!/^\d+$/.test(value)) return { bad: value };  // numeric field: one number, nothing else
    const w = (f.name === "brand_id" ? BRAND_W : CAT_W)[value];
    factor *= w === undefined ? 0 : w;                // unknown id -> no rows, like the real thing
  }
  return { factor };
}

app.get("/v2/ajax/reports/custom/:core/:entity", (q, r) => {
  const entity = q.params.entity;
  hits[entity] = (hits[entity] || 0) + 1;

  const scope = scopeFactor(q.query);
  if (scope.bad !== undefined) {
    return r.status(200).type("text/plain").send(`Invalid Number: ${scope.bad}`);
  }
  const SF = scope.factor;

  const [fromS, toS] = String(q.query.date_range || "").split(" to ");
  const from = parse(fromS), to = parse(toS);
  if (isNaN(from) || isNaN(to)) return r.status(400).type("text/plain").send("bad date_range");

  const grouped = Boolean(q.query.facet_field);
  const statsResult = q.query.report_stats_result || null;   // e.g. stats_field_sum

  // The real endpoint refuses an interval query with no facet_field, in plain text with
  // HTTP 200. Reproduced here because assuming otherwise is exactly what shipped a
  // broken overlay: the mock was more permissive than the thing it stood in for.
  const hasInterval = q.query.gap && q.query.gap !== "0";
  if (hasInterval && !grouped) {
    return r.status(200).type("text/plain").send("Missing 'field' , path=interval_report/facet");
  }
  // Without an interval AND without a facet_field the real endpoint answers 200 with an
  // empty facets object — no error, no data.
  if (!hasInterval && !grouped) return r.json({ responseHeader: { QTime: 2 }, facets: {} });

  // The id x name pairing the brand pickers are built from: group on the id field,
  // sub-group on the name field. Mirrors the shape the real facet returns.
  const NAMES = { brand_id: { 5586: "DUPIXENT", 10789: "TZIELD", 777: "Sun Life" },
                  brandcat_id: { 41: "Sanofi", 72: "GSK" } };
  // Which category each brand sits under — the second facet the brand list asks for, so
  // two brands of the same name can be told apart.
  const OF_CAT = { 5586: "Sanofi", 10789: "Sanofi", 777: "GSK" };
  if (!hasInterval && NAMES[q.query.facet_field] && q.query.group_by_field) {
    const byCat = q.query.group_by_field === "brandcat_name" && q.query.facet_field === "brand_id";
    const pairs = Object.entries(NAMES[q.query.facet_field]).map(([id, name], n) => ({
      val: Number(id), count: 100 - n,
      facet: { buckets: [{ val: byCat ? (OF_CAT[id] || "Unfiled") : name, count: 100 - n }] },
    }));
    return r.json({ responseHeader: { QTime: 3 }, facets: { count: 300, group: { buckets: pairs } } });
  }

  const buckets = [];
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  let i = 0;
  while (cur <= to) {
    const month = ym(cur);
    if (!omitted.has(`${entity}|${month}`)) {
      const count = (entity === "job" ? 10 + i : 5 + i) * SF;
      const sum = 1000 * (i + 1) * SF;
      // Like the real API, the interval bucket carries only val/count/facet — the
      // aggregate exists ONLY inside the facet buckets.
      // "short" = rows exist that carry no value for the facet field, so the buckets
      // don't add up to the interval's own count.
      const b = { val: `${month}-01T00:00:00Z`, count: short === entity ? count + 3 : count };
      if (grouped) {
        // Two offices splitting the month's total 60/40.
        const a = count - Math.floor(count * 0.4), z = Math.floor(count * 0.4);
        b.facet = { buckets: [
          { val: "Havas London", count: a, ...(statsResult ? { [statsResult]: sum * 0.6 } : {}) },
          { val: "Havas Life Chelsea", count: z, ...(statsResult ? { [statsResult]: sum * 0.4 } : {}) },
        ] };
      }
      buckets.push(b);
    }
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    i++;
  }

  if (!hasInterval) {
    // gap=0 with a facet_field: one flat facet, plus the collection-wide count.
    const flat = [
      { val: "Havas London", count: 60 * SF, ...(statsResult ? { [statsResult]: 6000 * SF } : {}) },
      { val: "Havas Life Chelsea", count: 40 * SF, ...(statsResult ? { [statsResult]: 4000 * SF } : {}) },
    ];
    return r.json({ responseHeader: { QTime: 2 }, facets: { count: (short === entity ? 105 : 100) * SF, group: { buckets: flat } } });
  }
  r.json({ responseHeader: { QTime: 4 }, facets: { count: buckets.length, interval_report: { buckets } } });
});

app.listen(8910, () => console.log("[upstream-monthly] :8910"));
