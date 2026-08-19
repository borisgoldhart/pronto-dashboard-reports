import { Router } from "express";
import * as store from "../store.js";
import { searchUsers } from "../people.js";

/**
 * Multi-dashboard API (report-builder model).
 *
 * Access is decided by store.roleFor() on every request and never by anything
 * the client sends:
 *  - owner  — everything, including delete
 *  - editor — edit widgets, and invite or remove people
 *  - viewer — read-only, exactly like the public link
 *  - nobody — may still VIEW via the capability link (the GUID), as before
 *
 * Report data is cached per dashboard (d:<guid> partition) — see report.js — so
 * every member reads the same numbers.
 */

const router = Router();

const needAuth = (req, res) =>
  req.pronto?.mode === "none" ? (res.status(401).json({ ok: false, authRequired: true }), true) : false;

/** List my dashboards. */
router.get("/dashboards", async (req, res) => {
  if (needAuth(req, res)) return;
  const p = req.pronto;
  const rows = await store.listDashboardsWithRoles(p.mode === "env" ? { all: true } : { ownerId: p.identity?.id });
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
  const role = anonymous ? null : store.roleFor(doc, req.pronto);
  res.json({
    ok: true, ...doc,
    role,
    canEdit: !anonymous && store.canEdit(doc, req.pronto),
    canShare: !anonymous && store.canShare(doc, req.pronto),
    canDelete: !anonymous && store.canDelete(doc, req.pronto),
    public: anonymous,
  });
});

/** Save — owner or editor. */
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

/** Delete — owner only. An editor can change anything except make it vanish. */
router.delete("/dashboard/:guid", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!store.canDelete(doc, req.pronto)) return res.status(403).json({ ok: false, error: "Only the owner can delete this dashboard" });
  res.json({ ok: await store.deleteDashboard(req.params.guid) });
});

/* ---- sharing ---------------------------------------------------------------- */

/** Look up Pronto users for the invite picker. Any signed-in user may search —
 *  it returns nothing they couldn't already see in Pronto itself. */
router.get("/users/search", async (req, res) => {
  if (needAuth(req, res)) return;
  const r = await searchUsers(req.query.q, { auth: req.pronto?.auth || null });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error, authRequired: r.authRequired });
  res.json({ ok: true, users: r.users });
});

/** Who is on this dashboard. Visible to anyone with a role on it. */
router.get("/dashboard/:guid/members", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!store.roleFor(doc, req.pronto)) return res.status(403).json({ ok: false, error: "No access to this dashboard" });
  res.json({
    ok: true,
    owner: doc.createdBy || null,
    members: doc.members || [],
    canShare: store.canShare(doc, req.pronto),
  });
});

/** Invite someone, or change the role they already have. Owner or editor. */
router.post("/dashboard/:guid/members", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!store.canShare(doc, req.pronto)) {
    return res.status(403).json({ ok: false, error: "Only the owner or an editor can change who this is shared with" });
  }
  const { id, name, email, role } = req.body || {};
  const r = await store.setMember(req.params.guid, { id, name, email, role }, req.pronto.identity);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, members: r.members });
});

/** Remove someone. Owner or editor; the owner can't be removed by anyone. */
router.delete("/dashboard/:guid/members/:id", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await store.getDashboard(req.params.guid);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!store.canShare(doc, req.pronto)) {
    return res.status(403).json({ ok: false, error: "Only the owner or an editor can change who this is shared with" });
  }
  if (doc.createdBy?.id != null && String(doc.createdBy.id) === String(req.params.id)) {
    return res.status(400).json({ ok: false, error: "The owner can't be removed from their own dashboard" });
  }
  const r = await store.removeMember(req.params.guid, req.params.id);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, members: r.members });
});

export default router;
