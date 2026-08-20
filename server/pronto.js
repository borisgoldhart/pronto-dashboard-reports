import { config } from "./config.js";
import { authMode, getSessionCookie, getToken, invalidate, prontoVerifyToken, prontoRefreshToken } from "./session.js";
import {
  DATA_SOURCES, DISPLAY_AS, INTERVALS, FIELDS,
  resolveDataSource, resolveField, resolveGap, officeFieldFor,
} from "./fields.js";

/**
 * Pronto Reporting API client.
 * Endpoint (per RUNBOOK-pronto-reporting-api.md):
 *   GET {base}/v2/ajax/reports/custom/{core}/{entity}?<params>
 * Returns Solr JSON: facets.interval_report.buckets[] (one per interval)
 *   -> .facet.buckets[] (one per group) with { count, stats_field_sum }.
 *
 * The enum/field metadata now lives in fields.js (captured from the legacy builder).
 * spec.dataSource / spec.groupBy / spec.interval accept either the real legacy values
 * (e.g. "asset", "client_office_name", "1MONTH") or the old Phase-2 short keys
 * (e.g. "assets", "client_office", "month") via the alias resolvers.
 */
export { DATA_SOURCES, DISPLAY_AS, INTERVALS, FIELDS };

/** Convert an ISO date (YYYY-MM-DD) to the API's DD-MM-YYYY, pass through if already DD-MM-YYYY. */
export function toApiDate(d) {
  if (!d) return d;
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return d;
}

/**
 * Build the querystring for a widget spec.
 * spec = {
 *   dataSource, groupBy, interval, displayAs,
 *   statsField?, dateFrom, dateTo, limit?, filters?: [{name,value}]
 * }
 */
export function buildParams(spec) {
  const src = resolveDataSource(spec.dataSource);
  if (!src) throw new Error(`Unknown dataSource: ${spec.dataSource}`);
  // groupBy "none"/empty => no facet_field at all (ungrouped totals per interval).
  const grouped = Boolean(spec.groupBy) && spec.groupBy !== "none";
  const facetField = grouped ? resolveField(spec.groupBy) : null;
  const gap = resolveGap(spec.interval);
  const display = DISPLAY_AS[spec.displayAs] || DISPLAY_AS.count;

  // Structure mirrors the legacy report-builder URLs, kept MINIMAL to match the fast
  // direct queries: page_id, date_range, facet_field, widget_id, limit, gap.
  //  • The interval split (facets.interval_report) is driven by `gap` alone; no interval
  //    (gap=0) returns a flat facets.group. normalize() handles both.
  //  • result_type/report_stats_* are added ONLY for aggregates (sum/min/max/mean/stddev).
  //    We deliberately do NOT send result_type/report_percentage for plain counts — those
  //    make the backend compute per-bucket percentages/stats and are much slower.
  const params = new URLSearchParams();
  params.set("page_id", "1840");
  params.set("date_range", `${toApiDate(spec.dateFrom)} to ${toApiDate(spec.dateTo)}`);
  if (facetField) params.set("facet_field", facetField);
  params.set("widget_id", "784331");
  params.set("limit", String(spec.limit ?? 60));
  params.set("gap", gap || "0");

  if (display.statsResult) {
    const statsField = spec.statsField || src.defaultStatsField;
    if (!statsField) {
      throw new Error(`displayAs=${spec.displayAs} requires a statsField (a numeric field) for dataSource=${spec.dataSource}`);
    }
    params.set("result_type", "graph_stats");
    params.set("report_stats_field", statsField);
    params.set("report_stats_result", display.statsResult);
  }

  // Sub-group (legacy SUBGROUP) => `group_by_field`. Note the naming quirk: facet_field is
  // the main group, group_by_field is the SUB-group. Only honoured when there is no
  // interval — with a gap the API ignores it (verified), so the UI forces gap=0.
  const subField = spec.subGroup && spec.subGroup !== "none" ? resolveField(spec.subGroup) : null;
  if (subField) params.set("group_by_field", subField);

  (spec.filters || []).forEach((f, i) => {
    if (!f || !f.name) return;
    params.set(`filter_fields[${i}][name]`, resolveField(f.name));
    params.set(`filter_fields[${i}][value]`, f.value);
  });

  return { params, core: src.core, entity: src.entity };
}

/** Detect the Solr plain-text errors the reporting endpoint returns with HTTP 200. */
export function normalizeSolrError(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.length > 300) return null; // real payloads are large JSON, not short text
  if (/undefined field/i.test(t) || /error|exception|invalid|not found/i.test(t)) {
    return `API rejected the query: ${t}`;
  }
  return null;
}

export function buildUrl(spec) {
  const { params, core, entity } = buildParams(spec);
  return `${config.prontoBaseUrl}/v2/ajax/reports/custom/${core}/${entity}?${params.toString()}`;
}

/** One HTTP attempt against the reporting endpoint with a specific set of auth headers. */
async function attemptFetch(url, authHeaders, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...authHeaders },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // The endpoint returns HTTP 200 with a plain-text body for Solr-level errors
      // (e.g. `undefined field: "x"`). Also 401 "Session Expired" comes back as JSON.
      const solrErr = normalizeSolrError(text);
      return { ok: false, status: res.status, url, error: solrErr || `Non-JSON response (len ${text.length}). First 200: ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, url, error: data?.errors || data?.message || data?.error || `HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, url, data, qtime: data?.responseHeader?.QTime };
  } catch (err) {
    return { ok: false, status: 0, url, error: err.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : String(err) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a report. The reporting endpoint is SESSION-COOKIE based: if an
 * `Authorization: Bearer` header is present it uses the (slow / often failing) bearer
 * path and IGNORES the cookie. So we send the session COOKIE ONLY first (the browser's
 * fast path), and only fall back to the bearer token if the cookie path 401s. On a
 * final 401 we re-login once and retry.
 */
export async function fetchReport(spec, { timeoutMs = 90000, auth = null } = {}) {
  if (!auth && authMode() === "none") {
    return { ok: false, status: 401, authRequired: true, error: "Not signed in. Log in with your HavasPronto account." };
  }
  const url = buildUrl(spec);

  // ---- per-user session auth (multi-user mode) ----
  // Cookie-only first (fast path), bearer fallback. If both 401 but the token is
  // still valid, re-bootstrap a fresh session cookie via /me once and retry.
  if (auth) {
    const userStrategies = [];
    if (auth.cookie) userStrategies.push({ label: "user-cookie", headers: { Cookie: auth.cookie } });
    if (auth.token) userStrategies.push({ label: "user-bearer", headers: { Authorization: `Bearer ${auth.token}` } });
    let result = { ok: false, status: 401, error: "Session has no usable credentials" };
    for (const s of userStrategies) {
      result = await attemptFetch(url, s.headers, timeoutMs);
      result.authUsed = s.label;
      if (result.status !== 401) return result;
    }
    if (auth.token) {
      const v = await prontoVerifyToken(auth.token);
      if (v.ok && v.cookie) {
        auth.cookie = v.cookie;
        if (typeof auth.onCookieRefresh === "function") { try { auth.onCookieRefresh(v.cookie); } catch {} }
        result = await attemptFetch(url, { Cookie: v.cookie }, timeoutMs);
        result.authUsed = "user-cookie";
        if (result.status !== 401) return result;
      }
      // Last resort before re-login: refresh grant (contract from the Time Tracker
      // app — POST /v2/api/auth/refresh authorised by the current access token).
      const rf = await prontoRefreshToken(auth.token);
      if (rf.ok && rf.token) {
        auth.token = rf.token;
        if (rf.cookie) auth.cookie = rf.cookie;
        if (typeof auth.onTokenRefresh === "function") { try { auth.onTokenRefresh(rf.token, rf.cookie || null); } catch {} }
        // bootstrap a session cookie from the fresh token (fast path), then retry
        const v2 = await prontoVerifyToken(rf.token);
        if (v2.ok && v2.cookie) {
          auth.cookie = v2.cookie;
          if (typeof auth.onCookieRefresh === "function") { try { auth.onCookieRefresh(v2.cookie); } catch {} }
        }
        if (auth.cookie) {
          result = await attemptFetch(url, { Cookie: auth.cookie }, timeoutMs);
          result.authUsed = "user-cookie-refreshed";
          if (result.status !== 401) return result;
        }
        result = await attemptFetch(url, { Authorization: `Bearer ${rf.token}` }, timeoutMs);
        result.authUsed = "user-bearer-refreshed";
        if (result.status !== 401) return result;
      }
    }
    result.authRequired = true;   // token itself is dead -> the user must sign in again
    return result;
  }

  // Build ordered auth strategies: cookie-only first (fast), bearer as fallback.
  const strategies = async (forceRefresh) => {
    if (authMode() === "cookie") return [{ label: "cookie", headers: { Cookie: config.cookie } }];
    const out = [];
    const cookie = await getSessionCookie({ forceRefresh });
    if (cookie) out.push({ label: "cookie", headers: { Cookie: cookie } });          // fast path (no Authorization!)
    const token = await getToken({ forceRefresh });
    if (token) out.push({ label: "bearer", headers: { Authorization: `Bearer ${token}` } }); // fallback
    return out;
  };

  let result;
  for (const s of await strategies(false)) {
    result = await attemptFetch(url, s.headers, timeoutMs);
    result.authUsed = s.label;
    if (result.status !== 401) return result;                       // success or a non-auth error
  }
  // Everything 401'd -> refresh session once and retry the ordered strategies.
  if (authMode() === "login") {
    invalidate();
    for (const s of await strategies(true)) {
      result = await attemptFetch(url, s.headers, timeoutMs);
      result.authUsed = s.label;
      if (result.status !== 401) return result;
    }
  }
  return result;
}

/**
 * Merge several Solr responses (one per office filter) into one, summing counts and
 * stats sums per (interval, group). Offices are disjoint, so summing is correct.
 */
export function mergeSolrResponses(datas) {
  const base = datas[0] || {};
  const intervalMap = new Map();  // intervalVal -> Map(groupVal -> {val,count,stats_field_sum,...})
  const intervalMeta = new Map(); // intervalVal -> summed interval-level {count, stats_field_*}
  for (const d of datas) {
    const ivb = d?.facets?.interval_report?.buckets || [];
    let entries;
    if (ivb.length) {
      // Per-interval (gap set). Keep the interval bucket itself as meta so its own
      // count/stats survive the merge (needed for ungrouped queries and "Other").
      entries = ivb.map((ib) => [ib.val, ib.facet?.buckets || [], ib]);
    } else {
      // Flat shape (gap=0): data under facets.group. A truly EMPTY sub-response
      // (no intervals, no flat groups — e.g. one office/month-chunk with no rows)
      // contributes NOTHING. Previously it injected a spurious empty "Total"
      // interval alongside the real months, adding a ghost column to charts.
      const flat = d?.facets?.group?.buckets || [];
      entries = flat.length ? [["Total", flat, { count: d?.facets?.count }]] : [];
    }
    for (const [ival, gbs, meta] of entries) {
      if (!intervalMap.has(ival)) intervalMap.set(ival, new Map());
      const m = intervalMeta.get(ival) || {};
      if (meta) {
        if (typeof meta.count === "number") m.count = (m.count || 0) + meta.count;
        for (const k of Object.keys(meta)) {
          if (k.startsWith("stats_field_")) m[k] = (m[k] || 0) + (meta[k] || 0);
        }
      }
      intervalMeta.set(ival, m);
      const gmap = intervalMap.get(ival);
      for (const gb of gbs) {
        const cur = gmap.get(gb.val) || { val: gb.val, count: 0 };
        cur.count += gb.count || 0;
        for (const k of Object.keys(gb)) {
          if (k.startsWith("stats_field_")) cur[k] = (cur[k] || 0) + (gb[k] || 0);
        }
        gmap.set(gb.val, cur);
      }
    }
  }
  const buckets = [...intervalMap.entries()].map(([val, gmap]) => ({
    ...(intervalMeta.get(val) || {}),
    val,
    facet: { buckets: [...gmap.values()].sort((a, b) => (b.count || 0) - (a.count || 0)) },
  })).sort((a, b) => String(a.val).localeCompare(String(b.val)));
  return { ...base, facets: { ...(base.facets || {}), interval_report: { buckets } } };
}

/**
 * The scope filters a spec fans out over: offices, brand categories, brands.
 *
 * Each is an "any of these values" filter, and the API cannot express that in one call.
 * Same-field filters are ANDed, and the numeric id fields reject OR syntax outright —
 * filtering brand_id on "(5586 OR 10789)" comes back as
 *
 *     Invalid Number: (5586 OR 10789)
 *
 * so an OR across values is only expressible as separate queries whose results are
 * merged. (The *_name fields do accept `("A" OR "B")` in a single call, but they match
 * on words rather than on values — a brandcat_name filter of "Havas Life" also matches
 * "Sun Life" and "SK Life Science" — which is why the picker sends ids.)
 *
 * Combining dimensions is a cross product: 2 offices x 3 brands = 6 queries. Each is
 * narrower than the unfiltered one, but the count still multiplies, hence MAX_COMBOS.
 */
export const MAX_COMBOS = 24;

const idsOf = (list) => (list || [])
  .map((v) => (v && typeof v === "object" ? v.id : v))
  .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
  .map((v) => String(v).trim());

/** Every extra-filter set this spec's scope expands to. Always at least one (possibly empty). */
export function filterCombos(spec) {
  const officeField = spec.officeField || officeFieldFor(spec.dataSource);
  const dims = [
    (spec.officeFilters || []).filter(Boolean).map((o) => ({ name: officeField, value: o })),
    idsOf(spec.brandcatFilters).map((id) => ({ name: "brandcat_id", value: id })),
    idsOf(spec.brandFilters).map((id) => ({ name: "brand_id", value: id })),
  ];
  let combos = [[]];
  for (const options of dims) {
    if (!options.length) continue;                      // dimension not scoped: leave it open
    combos = combos.flatMap((c) => options.map((o) => [...c, o]));
  }
  return combos;
}

/**
 * Fetch a report across every combination of its scope filters, merging the results.
 * One combination — the common case — is a single plain query.
 */
export async function fetchReportWithOffices(spec, opts = {}) {
  const combos = filterCombos(spec);
  const withCombo = (combo) => ({ ...spec, filters: [...(spec.filters || []), ...combo] });

  if (combos.length === 1) return fetchReport(withCombo(combos[0]), opts);
  if (combos.length > MAX_COMBOS) {
    return {
      ok: false,
      status: 400,
      error: `This widget's office and brand filters combine into ${combos.length} separate queries `
        + `(the reporting API can't OR them into one). The limit is ${MAX_COMBOS} — narrow the selection.`,
    };
  }
  // Fan out with limited concurrency (the backend throttles under heavy parallelism).
  const CONCURRENCY = 2;
  const results = new Array(combos.length);
  let next = 0;
  async function worker() {
    while (next < combos.length) {
      const i = next++;
      results[i] = await fetchReport(withCombo(combos[i]), opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, combos.length) }, worker));
  const bad = results.find((r) => !r.ok);
  if (bad) return bad;
  return { ok: true, status: 200, merged: combos.length, data: mergeSolrResponses(results.map((r) => r.data)) };
}

/**
 * Normalize the Solr response into a chart-friendly shape:
 * { intervals: [{ label, groups: [{ name, value }] }], series: [name...], totals }
 */
export function normalize(data, { displayAs = "count", showOther = false, grouped = true, subGroupLimit = 0, subGroupMode = "per-group" } = {}) {
  const bucketField = DISPLAY_AS[displayAs]?.bucketField || "count";
  const isCount = bucketField === "count";
  const seriesSet = new Set();
  // "Other" always sorts last so it sits at the end of the legend / top of the stack.
  const orderSeries = (set) => { const a = [...set].filter((s) => s !== "Other"); if (set.has("Other")) a.push("Other"); return a; };
  const toGroup = (gb) => { seriesSet.add(gb.val); return { name: gb.val, value: gb[bucketField] ?? gb.count ?? 0 }; };

  // "Other" = the API's total record count for the scope, minus the limited buckets it
  // returned. Only meaningful for counts (there's no comparable total for sum/mean).
  const withOther = (groups, total) => {
    if (!showOther || !isCount || typeof total !== "number") return groups;
    const sum = groups.reduce((a, g) => a + (Number(g.value) || 0), 0);
    const other = total - sum;
    if (other > 0) { seriesSet.add("Other"); return [...groups, { name: "Other", value: other }]; }
    return groups;
  };

  const intervalBuckets = data?.facets?.interval_report?.buckets || [];

  // Ungrouped (no facet_field): each interval bucket carries its own total.
  if (!grouped && intervalBuckets.length) {
    seriesSet.add("Total");
    const intervals = intervalBuckets.map((ib) => ({
      label: ib.val,
      groups: [{ name: "Total", value: ib[bucketField] ?? ib.count ?? 0 }],
    }));
    return { intervals, series: [...seriesSet], count: intervals.length };
  }

  // Shape A — grouped with an interval: interval_report.buckets[].facet.buckets
  if (intervalBuckets.some((ib) => ib.facet?.buckets?.length)) {
    const intervals = intervalBuckets.map((ib) => ({
      label: ib.val,
      groups: withOther((ib.facet?.buckets || []).map(toGroup), ib.count),
    }));
    return { intervals, series: [...seriesSet], count: intervals.length };
  }

  // Shape C — SUB-GROUPED (no interval): facets.group.buckets[] (the group, e.g. Office)
  // each nesting .facet.buckets[] (the sub-group, e.g. Brand). The x-axis becomes the
  // group and the series become the sub-group values.
  const groupBuckets = data?.facets?.group?.buckets || [];
  if (groupBuckets.some((b) => b.facet?.buckets?.length)) {
    const valOf = (sb) => sb[bucketField] ?? sb.count ?? 0;

    // Two ways to cap the series:
    //  • "per-group"  — each group keeps its own strongest sub-groups. Best for STACKED
    //                   charts (a group simply has no segment for a series it lacks).
    //  • "global"     — one shared set ranked by total across all groups. Best for
    //                   GROUPED bars, which reserve a slot per series per category and
    //                   would otherwise show blank gaps where a group has no value.
    let globalKeep = null;
    if (subGroupMode === "global" && subGroupLimit > 0) {
      const totals = new Map();
      groupBuckets.forEach((b) => (b.facet?.buckets || []).forEach((sb) => {
        totals.set(sb.val, (totals.get(sb.val) || 0) + valOf(sb));
      }));
      if (totals.size > subGroupLimit) {
        globalKeep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1])
          .slice(0, subGroupLimit).map(([v]) => v));
      }
    }

    const intervals = groupBuckets.map((b) => {
      const raw = b.facet?.buckets || [];
      let subs = raw.map((sb) => ({ name: sb.val, value: valOf(sb) }))
                    .sort((x, y) => y.value - x.value);
      let other = 0;
      if (globalKeep) {
        const kept = [];
        subs.forEach((s) => { if (globalKeep.has(s.name)) kept.push(s); else other += s.value; });
        // keep the shared order so every category lines up
        subs = [...globalKeep].map((n) => kept.find((k) => k.name === n) || { name: n, value: 0 });
      } else if (subGroupLimit > 0 && subs.length > subGroupLimit) {
        other += subs.slice(subGroupLimit).reduce((a, g) => a + g.value, 0);
        subs = subs.slice(0, subGroupLimit);
      }
      if (showOther && isCount && typeof b.count === "number") {
        const shown = raw.reduce((a, sb) => a + valOf(sb), 0);
        other += Math.max(0, b.count - shown);             // trimmed by the API's own limit
      }
      subs.forEach((s) => seriesSet.add(s.name));
      if (other > 0) { seriesSet.add("Other"); subs.push({ name: "Other", value: other }); }
      return { label: b.val, groups: subs };
    });
    return { intervals, series: orderSeries(seriesSet), count: intervals.length, xAxisIsGroup: true };
  }

  // Shape B — no interval (gap=0): a flat facet, usually facets.group.buckets.
  const flat = data?.facets?.group?.buckets
    || Object.entries(data?.facets || {}).find(([k, v]) => k !== "interval_report" && v && Array.isArray(v.buckets))?.[1]?.buckets;
  if (flat && flat.length) {
    const groups = withOther(flat.map(toGroup), data?.facets?.count);
    return { intervals: [{ label: "Total", groups }], series: [...seriesSet], count: 1 };
  }

  // Ungrouped + no interval: a single total.
  if (!grouped && typeof data?.facets?.count === "number") {
    return { intervals: [{ label: "Total", groups: [{ name: "Total", value: data.facets.count }] }], series: ["Total"], count: 1 };
  }

  return { intervals: [], series: [], count: 0 };
}
