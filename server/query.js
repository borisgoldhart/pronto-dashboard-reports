import { fetchReportWithOffices, normalize, buildUrl, mergeSolrResponses } from "./pronto.js";
import { officeFieldFor } from "./fields.js";
import * as cache from "./cache.js";

/**
 * The report query engine — one code path shared by the live report route
 * (routes/report.js) and the snapshot builder (snapshots.js).
 *
 * This used to live inside routes/report.js. It was lifted out unchanged so a
 * snapshot freezes data through exactly the same fetch/retry/chunk/cache logic
 * a normal widget render uses — no second implementation to drift.
 */

/** The exact API URL(s) a spec maps to (one per office filter, else one). */
export function urlsFor(spec) {
  const offices = (spec.officeFilters || []).filter(Boolean);
  if (!offices.length) return [buildUrl(spec)];
  const field = spec.officeField || officeFieldFor(spec.dataSource);
  return offices.map((o) => buildUrl({ ...spec, filters: [...(spec.filters || []), { name: field, value: o }] }));
}

/** normalize() options derived from a widget spec. */
export const normOpts = (spec) => ({
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
export function comparisonRange(spec) {
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
export function buildDeltas(cur, prev) {
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

/**
 * Fetch one period: cache -> retry -> chunk+merge.
 *
 * `who` is the cache partition (`d:<guid>` for dashboard-scoped queries, the
 * per-user key otherwise). `anon` means cache-only: a miss cannot be fetched
 * because there are no credentials to fetch with.
 */
export async function runPeriod(spec, { who = "anon", auth = null, nocache = false, anon = false } = {}) {
  const u = urlsFor(spec);
  const cacheKey = [who, ...u].join(" | ");
  let data = nocache ? null : await cache.get(cacheKey);
  if (data) return { ok: true, data, cached: true, urls: u, meta: {} };
  if (anon) {
    return { ok: false, status: 424, urls: u, meta: {}, error:
      "No cached data for this widget yet — sign in to load it, or ask the dashboard owner to open it once." };
  }

  const t0 = Date.now();
  const fetchOpts = { auth };
  let result = await fetchOnceRetry(spec, fetchOpts);
  if (isRetryable(result)) {
    const chunkedResult = await fetchChunked(spec, nocache, who, fetchOpts);
    if (chunkedResult) result = chunkedResult;
  }
  const meta = {
    authUsed: result.authUsed, merged: result.merged, chunked: result.chunked,
    seconds: ((Date.now() - t0) / 1000).toFixed(1),
  };
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status, authRequired: result.authRequired, urls: u, meta };
  }
  // Only cache responses that actually contain rows — never cache an empty result
  // (which may be a throttle/degradation artifact, not a true "no data").
  if (normalize(result.data, normOpts(spec)).count > 0) await cache.set(cacheKey, result.data);
  return { ok: true, data: result.data, cached: false, urls: u, meta };
}

/**
 * Run a full widget spec — primary period plus the optional comparison period —
 * and return the shaped payload the client renders. This is exactly what the
 * /api/report/query response body carries, so a snapshot can store it verbatim
 * and replay it later without re-running anything.
 */
export async function runWidgetQuery(spec, opts = {}) {
  const urls = urlsFor(spec);
  const primary = await runPeriod(spec, opts);
  if (!primary.ok) {
    return { ok: false, error: primary.error, status: primary.status, authRequired: primary.authRequired, url: urls[0], urls, ...primary.meta };
  }
  const shaped = normalize(primary.data, normOpts(spec));

  let compare = null, deltas = null;
  const range = comparisonRange(spec);
  if (range) {
    const prevSpec = { ...spec, dateFrom: range.from, dateTo: range.to, compare: undefined };
    const secondary = await runPeriod(prevSpec, opts);
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

  return {
    ok: true,
    cached: primary.cached,
    url: urls[0],
    urls,
    ...primary.meta,
    ...shaped,
    ...(compare ? { compare, deltas } : {}),
    raw: primary.data,          // callers strip this unless ?raw=1 was asked for
  };
}
