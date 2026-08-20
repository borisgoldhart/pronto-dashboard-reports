import { Router } from "express";
import {
  DATA_SOURCES, DISPLAY_AS, INTERVALS, FIELDS, CHART_TYPES, DATE_PRESETS,
} from "../fields.js";
import * as cache from "../cache.js";
import { listOffices } from "../offices.js";
import { searchDimension, isDimension } from "../dimensions.js";
import { dashboardExists } from "../store.js";
import { urlsFor, runWidgetQuery } from "../query.js";

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

/**
 * Searchable list for a brand dimension: /dimension/brandcat or /dimension/brand.
 * Returns [{id, name, count}] — the picker shows the name and files the id, because
 * only the id fields match exactly (see dimensions.js).
 */
router.get("/dimension/:key", async (req, res) => {
  if (!req.pronto || req.pronto.mode === "none") {
    return res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
  }
  const key = String(req.params.key || "");
  if (!isDimension(key)) return res.status(400).json({ ok: false, error: `Unknown dimension: ${key}` });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const r = await searchDimension(key, req.query.q, { limit, auth: req.pronto?.auth });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error });
  res.json({ ok: true, total: r.total, items: r.items });
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
 *
 * The fetch/retry/chunk/compare machinery lives in ../query.js so the snapshot
 * builder freezes data through the identical code path.
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

    urls = urlsFor(spec); // the exact API URL(s) this query maps to (for transparency/debug)
    const result = await runWidgetQuery(spec, { who, auth: req.pronto?.auth || null, nocache, anon });
    if (!result.ok) {
      return res.status(result.status || 502).json({
        ok: false, error: result.error, authRequired: result.authRequired,
        url: urls[0], urls, seconds: result.seconds,
      });
    }
    const { raw, ...body } = result;
    res.json({
      ...body,
      fetchedAs: req.pronto?.identity || null,
      ...(wantRaw ? { raw } : {}),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err), url: urls[0], urls });
  }
});

router.get("/cache/stats", async (_req, res) => res.json(await cache.stats()));
router.post("/cache/clear", async (_req, res) => res.json({ cleared: await cache.clear() }));

export default router;
