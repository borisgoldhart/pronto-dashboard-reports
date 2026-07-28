import { Router } from "express";
import * as store from "../store.js";

/**
 * Multi-dashboard API (report-builder model).
 *
 * Sharing (MVP): a dashboard's GUID is an unguessable capability link.
 *  - listing shows only YOUR dashboards (env dev mode sees all)
 *  - anyone signed in with the link can view + refresh data
 *  - only the creator can save changes or delete (server-enforced)
 * Report data is cached per dashboard (d:<guid> partition) — see report.js.
 */

const router = Router();

const needAuth = (req, res) =>
  req.pronto?.mode === "none" ? (res.status(401).json({ ok: false, authRequired: true }), true) : false;

/** List my dashboards. */
router.get("/dashboards", async (req, res) => {
  if (needAuth(req, res)) return;
  const p = req.pronto;
  const rows = await store.listDashboards(p.mode === "env" ? { all: true } : { ownerId: p.identity?.id });
  res.json({ ok: true, dashboards: rows });
});

/** Create a dashboard. */
router.post("/dashboards", async (req, res) => {
  if (needAuth(req, res)) return;
  const { title, refreshInterval } = req.body || {};
  const doc = await store.createDashboard({ title, refreshInterval, identity: req.pronto.identity });
  res.json({ ok: true, ...doc, canEdit: true });
});

/** Read one dashboard. The GUID is the view capability: holders of the link may
 *  view WITHOUT signing in (public share view). Anonymous viewers get the widget
 *  definitions only — their data comes exclusively from the dashboard's cache
 *  partition (see report.js) and they cannot refresh, save or list. */
router.get("/dashboard/:guid", async (req, res) => {
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true, error: "Dashboard not found" });
  const anonymous = !req.pronto || req.pronto.mode === "none";
  res.json({ ok: true, ...doc, canEdit: !anonymous && store.canEdit(doc, req.pronto), public: anonymous });
});

/** Save — creator only. */
router.put("/dashboard/:guid", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true, error: "Dashboard not found" });
  if (!store.canEdit(doc, req.pronto)) {
    return res.status(403).json({ ok: false, error: "View only — this dashboard belongs to " + (doc.createdBy?.name || "another user") });
  }
  const saved = await store.saveDashboard(req.params.guid, req.body || {}, req.pronto.identity);
  res.json({ ok: true, ...saved, canEdit: true });
});

/** Stamp a full data refresh — any signed-in viewer may refresh (snapshot
 *  semantics: a refresh refetches and updates the shared data for everyone). */
router.post("/dashboard/:guid/refreshed", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.touchRefreshed(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  res.json({ ok: true, ...doc, canEdit: store.canEdit(doc, req.pronto) });
});

/** Delete — creator only. */
router.delete("/dashboard/:guid", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!store.canEdit(doc, req.pronto)) return res.status(403).json({ ok: false, error: "Only the creator can delete this dashboard" });
  res.json({ ok: await store.deleteDashboard(req.params.guid) });
});

export default router;
