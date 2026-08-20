import { fetchReportWithOffices, filterCombos, normalize, buildUrl, mergeSolrResponses } from "./pronto.js";
import { officeFieldFor, DISPLAY_AS, resolveDataSource } from "./fields.js";
import * as cache from "./cache.js";

/**
 * The report query engine — one code path shared by the live report route
 * (routes/report.js) and the snapshot builder (snapshots.js).
 *
 * This used to live inside routes/report.js. It was lifted out unchanged so a
 * snapshot freezes data through exactly the same fetch/retry/chunk/cache logic
 * a normal widget render uses — no second implementation to drift.
 */

/** The exact API URL(s) a spec maps to — one per office/brand-category/brand combination.
 *  Shares filterCombos() with the fetch path so the URLs shown for debugging, and the
 *  cache keys derived from them, can never describe a different query from the one run. */
export function urlsFor(spec) {
  return filterCombos(spec).map((combo) =>
    buildUrl(combo.length ? { ...spec, filters: [...(spec.filters || []), ...combo] } : spec));
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

// ---- second data source (overlay) ------------------------------------------------
/** How many facet values an overlay asks for. See overlaySpecFor(). */
const OVERLAY_FACET_LIMIT = 600;

/**
 * The spec for the overlay query, or null when there isn't one.
 *
 * An overlay is a SINGLE total per interval: the primary may be split into a dozen
 * stacked series, and splitting the second source the same way would produce an
 * unreadable thicket of lines. Everything that defines the x-axis — dates, interval,
 * offices, filters — is inherited, because two series can only be compared if they
 * were measured over the same windows.
 *
 * It nonetheless asks for a GROUPED query, which looks wrong and isn't. The reporting
 * API rejects an interval query with no facet_field outright:
 *
 *     Missing 'field' , path=interval_report/facet
 *
 * so "no grouping, just totals over time" is not a request it will answer. We therefore
 * facet on the source's own office dimension and add the buckets up again in
 * overlayTotals(). The office field is the right choice because every row has one, which
 * is what makes the sum complete — and overlayTotals() verifies that rather than
 * assuming it.
 */
export function overlaySpecFor(spec) {
  const o = spec.overlay || {};
  if (!o.enabled || !o.dataSource) return null;
  return {
    ...spec,
    dataSource: o.dataSource,
    displayAs: o.displayAs || "count",
    statsField: o.statsField || undefined,
    groupBy: officeFieldFor(o.dataSource),   // required by the API; summed back up below
    subGroup: "none",
    limit: OVERLAY_FACET_LIMIT,
    // The office FILTER has to be re-resolved too: officeFilters apply to the office
    // field OF THE SOURCE, and timesheet rows hang off the user's office while jobs
    // hang off the project's office. Dropping spec.officeField makes urlsFor() pick the
    // right one for the overlay source instead of reusing the primary's.
    officeField: undefined,
    overlay: undefined,
    compare: undefined,       // an overlay never carries its own comparison period
  };
}

/**
 * One total per interval, from a grouped response.
 *
 * Counts come from the interval bucket's own `count`, which the API reports for the
 * whole interval and is therefore exact however many groups came back.
 *
 * Sums and the other aggregates do NOT appear at interval level — verified against the
 * live API, where an interval bucket carries only { val, count, facet }. They exist only
 * inside the facet buckets, so the total has to be re-assembled by adding those up. That
 * is only correct if we got ALL of them, so completeness is checked rather than hoped
 * for: the facet counts must add up to the interval's own count. If they don't, some
 * rows were left out and the total would be quietly short — the caller is told so it can
 * say as much, instead of drawing a confident line that is too low.
 */
export function overlayTotals(data, { displayAs = "count" } = {}) {
  const field = DISPLAY_AS[displayAs]?.bucketField || "count";
  const useIntervalCount = field === "count";
  const byLabel = new Map();
  let complete = true;

  (data?.facets?.interval_report?.buckets || []).forEach((ib) => {
    const facets = ib.facet?.buckets || [];
    if (useIntervalCount) {
      byLabel.set(String(ib.val), Number(ib.count) || 0);
      return;
    }
    const covered = facets.reduce((a, b) => a + (Number(b.count) || 0), 0);
    if (typeof ib.count === "number" && covered !== ib.count) complete = false;
    byLabel.set(String(ib.val), facets.reduce((a, b) => a + (Number(b[field]) || 0), 0));
  });

  return { byLabel, complete };
}

// ---- "No grouping (totals only)" ------------------------------------------------
/**
 * The API will not answer an ungrouped query. With an interval it refuses outright
 * (`Missing 'field' , path=interval_report/facet`); without one it returns HTTP 200 and
 * an empty `facets: {}`. Either way "just the totals over time" — a reasonable thing to
 * ask a reporting API — has never worked in this app.
 *
 * The fix is the same trick the overlay uses: ask for a grouped query on a dimension
 * every row has, then add the buckets back up.
 */
export const isUngrouped = (spec) => !spec.groupBy || spec.groupBy === "none";

export function ungroupedSpecFor(spec) {
  return { ...spec, groupBy: officeFieldFor(spec.dataSource), subGroup: "none", limit: OVERLAY_FACET_LIMIT };
}

/** Shape a forced-facet response back into the single "Total" series the user asked for. */
export function ungroupedShape(data, spec) {
  const field = DISPLAY_AS[spec.displayAs]?.bucketField || "count";
  const one = (label, value) => ({ label, groups: [{ name: "Total", value }] });

  const ivs = data?.facets?.interval_report?.buckets;
  if (Array.isArray(ivs) && ivs.length) {
    const { byLabel, complete } = overlayTotals(data, { displayAs: spec.displayAs });
    return {
      intervals: ivs.map((ib) => one(ib.val, byLabel.get(String(ib.val)) ?? 0)),
      series: ["Total"], count: ivs.length, partial: !complete,
    };
  }

  // No interval: one flat facet, totalled the same way.
  const flat = data?.facets?.group?.buckets || [];
  const apiTotal = data?.facets?.count;
  const total = field === "count"
    ? (typeof apiTotal === "number" ? apiTotal : flat.reduce((a, b) => a + (Number(b.count) || 0), 0))
    : flat.reduce((a, b) => a + (Number(b[field]) || 0), 0);
  const covered = flat.reduce((a, b) => a + (Number(b.count) || 0), 0);
  const complete = field === "count" || typeof apiTotal !== "number" || covered === apiTotal;
  return { intervals: flat.length || typeof apiTotal === "number" ? [one("Total", total)] : [], series: ["Total"], count: 1, partial: !complete };
}

/**
 * Line up the overlay's totals with the primary's buckets BY LABEL, not by position.
 *
 * The API omits a bucket entirely when a source has no rows in that window, so a
 * source that is quiet in March comes back one bucket short — and a positional merge
 * would then draw every later month's value one month early. Missing buckets become
 * null (a gap in the line), never 0, because "no rows" and "zero hours" are different
 * claims and only one of them is true.
 */
export function alignOverlay(primaryIntervals, byLabel) {
  return (primaryIntervals || []).map((iv) => {
    const v = byLabel.get(String(iv.label));
    return { label: iv.label, value: v === undefined ? null : v };
  });
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
  // "No grouping" is asked for as a grouped query and totalled back up — see
  // ungroupedSpecFor(). Everything downstream (cache key, comparison, chunking) uses
  // the rewritten spec so there is only ever one query shape in play.
  const ungrouped = isUngrouped(spec);
  const qspec = ungrouped ? ungroupedSpecFor(spec) : spec;
  const shapeOf = (data, sp) => (ungrouped ? ungroupedShape(data, sp) : normalize(data, normOpts(sp)));

  const urls = urlsFor(qspec);
  const primary = await runPeriod(qspec, opts);
  if (!primary.ok) {
    return { ok: false, error: primary.error, status: primary.status, authRequired: primary.authRequired, url: urls[0], urls, ...primary.meta };
  }
  const shaped = shapeOf(primary.data, spec);

  let compare = null, deltas = null;
  const range = comparisonRange(spec);
  if (range) {
    const prevSpec = { ...qspec, dateFrom: range.from, dateTo: range.to, compare: undefined };
    const secondary = await runPeriod(prevSpec, opts);
    if (secondary.ok) {
      const shapedPrev = shapeOf(secondary.data, prevSpec);
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

  // Second data source, drawn as a line over the primary's bars. A failure here is
  // reported inside the widget rather than failing the whole render: the bars are
  // still worth showing, and the tile says why the line is missing.
  let overlay = null;
  const ospec = overlaySpecFor(spec);
  if (ospec) {
    // try/catch, not just !res.ok: an unknown source or a bad stats field throws out of
    // buildParams, and that must not take the bars down with it.
    let res;
    try {
      res = await runPeriod(ospec, opts);
    } catch (err) {
      res = { ok: false, error: String(err.message || err) };
    }
    if (res.ok) {
      const { byLabel, complete } = overlayTotals(res.data, { displayAs: ospec.displayAs });
      overlay = {
        dataSource: ospec.dataSource,
        displayAs: ospec.displayAs,
        statsField: ospec.statsField || null,
        cached: res.cached,
        url: res.urls[0],
        points: alignOverlay(shaped.intervals, byLabel),
        ...(complete ? {} : { partial: true, note:
          `Some ${(resolveDataSource(ospec.dataSource) || {}).label || ospec.dataSource} rows have no office recorded, `
          + `so this line is lower than the true total.` }),
      };
    } else {
      overlay = { dataSource: ospec.dataSource, displayAs: ospec.displayAs, error: res.error || "Could not load the second data source." };
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
    ...(overlay ? { overlay } : {}),
    // An ungrouped total is assembled from facet buckets, so it can fall short if some
    // rows carry no office. Say so rather than showing a confident number that is low.
    ...(shaped.partial ? { partial: true, note:
      `Some rows have no office recorded, so this total is lower than the true figure.` } : {}),
    raw: primary.data,          // callers strip this unless ?raw=1 was asked for
  };
}
