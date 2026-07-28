import { Router } from "express";
import { fetchReport, fetchReportWithOffices, normalize, buildUrl, mergeSolrResponses } from "../pronto.js";
import {
  DATA_SOURCES, DISPLAY_AS, INTERVALS, FIELDS, CHART_TYPES, DATE_PRESETS, officeFieldFor,
} from "../fields.js";
import * as cache from "../cache.js";
import { listOffices } from "../offices.js";
import { dashboardExists } from "../store.js";

/** The exact API URL(s) a spec maps to (one per office filter, else one). */
function urlsFor(spec) {
  const offices = (spec.officeFilters || []).filter(Boolean);
  if (!offices.length) return [buildUrl(spec)];
  const field = spec.officeField || officeFieldFor(spec.dataSource);
  return offices.map((o) => buildUrl({ ...spec, filters: [...(spec.filters || []), { name: field, value: o }] }));
}

/** normalize() options derived from a widget spec. */
const normOpts = (spec) => ({
  displayAs: spec.displayAs,
  showOther: Boolean(spec.showOther),
  grouped: Boolean(spec.groupBy) && spec.groupBy !== "none",
  subGroupLimit: Number(spec.subGroupLimit) || 0,   // 0 = no cap on series
  subGroupMode: spec.subGroupMode === "global" ? "global" : "per-group",
});

// ---- resilient fetch: retry once, then chunk the date range on failure ----
const isoDate = (d) => d.toISOString().slice(0, 10);
const isRetryable = (r) => !r.ok && (r.status === 0 || r.status >= 500); // timeout/network/5xx

/** Split [from,to] into calendar-month sub-ranges. */
function monthChunks(fromISO, toISO) {
  const chunks = [];
  let start = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  if (isNaN(start) || isNaN(end) || start > end) return chunks;
  while (start <= end) {
    const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push([isoDate(start), isoDate(chunkEnd)]);
    start = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return chunks;
}

async function fetchOnceRetry(spec, opts) {
  let r = await fetchReportWithOffices(spec, opts);
  if (isRetryable(r)) r = await fetchReportWithOffices(spec, opts); // one retry for transient failures
  return r;
}

/** Fetch a spec by splitting its date range into monthly chunks (each cached + retried),
 *  then merging. Returns null if there's nothing to chunk (single month). */
async function fetchChunked(spec, nocache, who = "anon", opts = undefined) {
  const chunks = monthChunks(spec.dateFrom, spec.dateTo);
  if (chunks.length <= 1) return null;
  const datas = new Array(chunks.length);
  let next = 0, failed = null;
  async function worker() {
    while (next < chunks.length && !failed) {
      const i = next++;
      const cspec = { ...spec, dateFrom: chunks[i][0], dateTo: chunks[i][1] };
      const ckey = [who, ...urlsFor(cspec)].join(" | ");
      let cdata = nocache ? null : await cache.get(ckey);
      if (!cdata) {
        const r = await fetchOnceRetry(cspec, opts);
        if (!r.ok) { failed = r; return; }
        cdata = r.data;
        if (normalize(cdata, normOpts(spec)).count > 0) await cache.set(ckey, cdata);
      }
      datas[i] = cdata;
    }
  }
  await Promise.all([worker(), worker()]); // concurrency 2 — gentle on the backend
  if (failed) return failed;
  return { ok: true, status: 200, data: mergeSolrResponses(datas.filter(Boolean)), chunked: chunks.length };
}

// ---- period comparison ----------------------------------------------------------
/** Resolve the comparison window for a spec, or null when comparison is off. */
function comparisonRange(spec) {
  const c = spec.compare || {};
  if (!c.enabled) return null;
  if (c.mode === "custom") return (c.dateFrom && c.dateTo) ? { from: c.dateFrom, to: c.dateTo } : null;

  const from = new Date(`${spec.dateFrom}T00:00:00Z`);
  const to = new Date(`${spec.dateTo}T00:00:00Z`);
  if (isNaN(from) || isNaN(to)) return null;

  if (c.mode === "previous-year") {
    const f = new Date(from), t = new Date(to);
    f.setUTCFullYear(f.getUTCFullYear() - 1);
    t.setUTCFullYear(t.getUTCFullYear() - 1);
    return { from: isoDate(f), to: isoDate(t) };
  }
  // default "previous-period": the equal-length window ending the day before `from`
  const days = Math.round((to - from) / 86400000);
  const t = new Date(from); t.setUTCDate(t.getUTCDate() - 1);
  const f = new Date(t);    f.setUTCDate(f.getUTCDate() - days);
  return { from: isoDate(f), to: isoDate(t) };
}

/** Total each group across intervals (comparisons are period-level, not per-bucket). */
function totalsByGroup(shaped) {
  const m = new Map();
  (shaped.intervals || []).forEach((iv) => (iv.groups || []).forEach((g) => {
    m.set(g.name, (m.get(g.name) || 0) + (Number(g.value) || 0));
  }));
  return m;
}

/** Per-group current vs previous, with absolute and % change. */
function buildDeltas(cur, prev) {
  const a = totalsByGroup(cur), b = totalsByGroup(prev);
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].map((name) => {
    const current = a.get(name) || 0;
    const previous = b.get(name) || 0;
    // % change is undefined when there's no baseline — flag it rather than divide by zero
    const changePct = previous > 0 ? ((current - previous) / previous) * 100 : (current > 0 ? null : 0);
    return { name, current, previous, change: current - previous, changePct };
  }).sort((x, y) => (y.changePct ?? Infinity) - (x.changePct ?? Infinity));
}

const router = Router();

/** Searchable list of offices (from the reporting facet; cached). ?q= filters. */
router.get("/offices", async (req, res) => {
  if (!req.pronto || req.pronto.mode === "none") {
    return res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
  }
  const r = await listOffices({ auth: req.pronto?.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error });
  const q = String(req.query.q || "").trim().toLowerCase();
  const offices = q ? r.offices.filter((o) => o.toLowerCase().includes(q)) : r.offices;
  res.json({ ok: true, count: offices.length, offices });
});

/** Metadata for the graph-builder UI: the full captured legacy option lists. */
router.get("/options", (_req, res) => {
  res.json({
    dataSources: Object.entries(DATA_SOURCES).map(([value, v]) => ({ value, label: v.label, defaultStatsField: v.defaultStatsField })),
    fields: FIELDS,                       // shared list for Group By / Sub-group / Filter
    intervals: Object.entries(INTERVALS).map(([value, v]) => ({ value, label: v.label })),
    displayAs: Object.entries(DISPLAY_AS).map(([value, v]) => ({ value, label: v.label })),
    chartTypes: CHART_TYPES,
    datePresets: DATE_PRESETS,
  });
});

/**
 * Run a report. Body = widget spec (see pronto.buildParams).
 * Query ?nocache=1 to bypass the cache. Query ?raw=1 to also return Solr JSON.
 */
router.post("/query", async (req, res) => {
  const spec = req.body || {};
  // Anonymous access: ONLY for widgets of a shared dashboard (valid GUID =
  // the view capability), ONLY from that dashboard's cache partition — never
  // an upstream fetch (there are no credentials) and never a cache bypass.
  // Everything else requires a session.
  const anon = !req.pronto || req.pronto.mode === "none";
  if (anon && !(typeof spec.dashboardId === "string" && await dashboardExists(spec.dashboardId))) {
    return res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
  }
  const nocache = !anon && req.query.nocache === "1";
  const wantRaw = req.query.raw === "1";

  let urls = [];
  try {
    // Cache partitioning. Queries carrying a valid dashboardId cache under the
    // DASHBOARD's partition (d:<guid>) — report-snapshot semantics: everyone who
    // opens that dashboard sees the same cached rows, whoever fetched them
    // (fetchedAs records who that was). Ad-hoc queries without a dashboard fall
    // back to the per-user partition, since the reporting API is permission-scoped.
    const dashGuid = typeof spec.dashboardId === "string" && await dashboardExists(spec.dashboardId) ? spec.dashboardId : null;
    const who = dashGuid ? `d:${dashGuid}` : (req.pronto?.key || "anon");
    const fetchOpts = { auth: req.pronto?.auth || null };

    /** Fetch one period (cache -> retry -> chunk+merge). Returns {data, cached, meta}. */
    async function runPeriod(s) {
      const u = urlsFor(s);
      const cacheKey = [who, ...u].join(" | ");
      let data = nocache ? null : await cache.get(cacheKey);
      if (data) return { ok: true, data, cached: true, urls: u, meta: {} };
      if (anon) {
        // cache-only mode: no credentials, so a miss cannot be fetched
        return { ok: false, status: 424, urls: u, meta: {}, error:
          "No cached data for this widget yet — sign in to load it, or ask the dashboard owner to open it once." };
      }

      const t0 = Date.now();
      let result = await fetchOnceRetry(s, fetchOpts);
      if (isRetryable(result)) {
        const chunkedResult = await fetchChunked(s, nocache, who, fetchOpts);
        if (chunkedResult) result = chunkedResult;
      }
      const meta = {
        authUsed: result.authUsed, merged: result.merged, chunked: result.chunked,
        seconds: ((Date.now() - t0) / 1000).toFixed(1),
      };
      if (!result.ok) return { ok: false, error: result.error, status: result.status, authRequired: result.authRequired, urls: u, meta };
      // Only cache responses that actually contain rows — never cache an empty result
      // (which may be a throttle/degradation artifact, not a true "no data").
      if (normalize(result.data, normOpts(s)).count > 0) await cache.set(cacheKey, result.data);
      return { ok: true, data: result.data, cached: false, urls: u, meta };
    }

    urls = urlsFor(spec); // the exact API URL(s) this query maps to (for transparency/debug)
    const primary = await runPeriod(spec);
    if (!primary.ok) {
      return res.status(primary.status || 502)
        .json({ ok: false, error: primary.error, authRequired: primary.authRequired, url: urls[0], urls, ...primary.meta });
    }
    const shaped = normalize(primary.data, normOpts(spec));

    // ---- optional second period for comparison charts ----
    let compare = null, deltas = null;
    const range = comparisonRange(spec);
    if (range) {
      const prevSpec = { ...spec, dateFrom: range.from, dateTo: range.to, compare: undefined };
      const secondary = await runPeriod(prevSpec);
      if (secondary.ok) {
        const shapedPrev = normalize(secondary.data, normOpts(prevSpec));
        compare = {
          dateFrom: range.from, dateTo: range.to,
          cached: secondary.cached, url: secondary.urls[0],
          intervals: shapedPrev.intervals, series: shapedPrev.series,
        };
        deltas = buildDeltas(shaped, shapedPrev);
      } else {
        compare = { dateFrom: range.from, dateTo: range.to, error: secondary.error };
      }
    }

    res.json({
      ok: true,
      cached: primary.cached,
      url: urls[0],
      urls,
      ...primary.meta,
      fetchedAs: req.pronto?.identity || null,
      ...shaped,
      ...(compare ? { compare, deltas } : {}),
      ...(wantRaw ? { raw: primary.data } : {}),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err), url: urls[0], urls });
  }
});

router.get("/cache/stats", async (_req, res) => res.json(await cache.stats()));
router.post("/cache/clear", async (_req, res) => res.json({ cleared: await cache.clear() }));

export default router;
