import { Router } from "express";
import * as store from "../store.js";
import * as snaps from "../snapshots.js";
import { runWidgetQuery } from "../query.js";

/**
 * Frozen share links.
 *
 * Taking a snapshot is a three-step conversation rather than one big request:
 *
 *   POST /api/dashboard/:guid/snapshot            -> create shell, freeze dates
 *   POST /api/snapshot/:id/capture/:widgetId      -> fetch + store ONE widget
 *   POST /api/snapshot/:id/finalize               -> mark it readable
 *
 * One widget per request keeps every call to roughly the cost of a normal
 * widget render (which production already sustains), instead of one request
 * that runs N slow report queries and trips the serverless execution limit. It
 * also lets the UI show honest progress while a big dashboard freezes.
 *
 * Reads are public — the snapId IS the capability, same model as the dashboard
 * GUID — but they only ever return stored bytes. There is no code path from an
 * anonymous snapshot view to an upstream fetch.
 */

const router = Router();

const needAuth = (req, res) =>
  req.pronto?.mode === "none" ? (res.status(401).json({ ok: false, authRequired: true }), true) : false;

/* ---- create ------------------------------------------------------------- */

/** Freeze a dashboard. Any signed-in user who can see it may take a snapshot. */
router.post("/dashboard/:guid/snapshot", async (req, res) => {
  if (needAuth(req, res)) return;
  const dash = await store.getDashboard(req.params.guid);
  if (!dash) return res.status(404).json({ ok: false, notFound: true, error: "Dashboard not found" });
  if (!(dash.widgets || []).length) {
    return res.status(400).json({ ok: false, error: "Nothing to freeze — this dashboard has no widgets yet." });
  }
  const doc = await snaps.createSnapshot(dash, req.pronto.identity, { note: req.body?.note });
  res.json({
    ok: true, snapId: doc.snapId, takenAt: doc.takenAt, widgetCount: doc.widgetCount,
    widgetIds: doc.widgets.map((w) => w.id),
  });
});

/** Fetch and store one widget's data into the snapshot. */
router.post("/snapshot/:snapId/capture/:widgetId", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await snaps.getSnapshot(req.params.snapId);
  if (!doc) return res.status(404).json({ ok: false, notFound: true, error: "Snapshot not found" });
  if (!snaps.canManage(doc, req.pronto)) {
    return res.status(403).json({ ok: false, error: "Only the person who started this snapshot can build it" });
  }

  // Freezing reads through the dashboard's normal cache partition, so a widget
  // the owner is already looking at is captured from cache in milliseconds.
  const r = await snaps.captureWidget(req.params.snapId, req.params.widgetId, (spec) =>
    runWidgetQuery(spec, { who: `d:${doc.guid}`, auth: req.pronto?.auth || null, nocache: false, anon: false }));

  if (!r.ok) return res.status(r.status || 500).json({ ok: false, error: r.error });
  res.json(r);
});

/** Close the snapshot for reading. */
router.post("/snapshot/:snapId/finalize", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await snaps.getSnapshot(req.params.snapId);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!snaps.canManage(doc, req.pronto)) return res.status(403).json({ ok: false, error: "Not yours to finalize" });
  const done = await snaps.finalizeSnapshot(req.params.snapId);
  res.json({ ok: true, snapId: done.snapId, status: done.status, widgetCount: done.widgetCount, capturedCount: done.capturedCount, errors: done.errors || [] });
});

/* ---- read (public) ------------------------------------------------------- */

/** The frozen dashboard: metadata + widget definitions. No credentials needed. */
router.get("/snapshot/:snapId", async (req, res) => {
  const doc = await snaps.getSnapshot(req.params.snapId);
  if (!doc) return res.status(404).json({ ok: false, notFound: true, error: "This snapshot link is no longer available." });
  res.json({
    ok: true,
    snapshot: true,
    snapId: doc.snapId,
    guid: doc.guid,
    title: doc.title,
    note: doc.note || "",
    takenAt: doc.takenAt,
    takenBy: doc.takenBy ? { name: doc.takenBy.name } : null,   // never leak the owner's email publicly
    status: doc.status,
    widgets: doc.widgets,
    widgetCount: doc.widgetCount,
    canEdit: false,
    manage: snaps.canManage(doc, req.pronto),
  });
});

/** One widget's frozen payload. Stored bytes only — never an upstream fetch. */
router.get("/snapshot/:snapId/data/:widgetId", async (req, res) => {
  const doc = await snaps.getSnapshot(req.params.snapId);
  if (!doc) return res.status(404).json({ ok: false, notFound: true, error: "This snapshot link is no longer available." });
  const row = await snaps.getSnapshotData(req.params.snapId, req.params.widgetId);
  if (!row) {
    return res.status(404).json({ ok: false, error: "This widget wasn't captured in the snapshot." });
  }
  res.json({ ok: true, capturedAt: row.capturedAt, ...row.payload });
});

/* ---- manage -------------------------------------------------------------- */

/** Snapshots taken from a dashboard (owner's list). */
router.get("/dashboard/:guid/snapshots", async (req, res) => {
  if (needAuth(req, res)) return;
  const rows = await snaps.listSnapshots(req.params.guid);
  res.json({ ok: true, snapshots: rows });
});

/** Revoke — kills the link and deletes the stored data. */
router.delete("/snapshot/:snapId", async (req, res) => {
  if (needAuth(req, res)) return;
  const doc = await snaps.getSnapshot(req.params.snapId);
  if (!doc) return res.status(404).json({ ok: false, notFound: true });
  if (!snaps.canManage(doc, req.pronto)) return res.status(403).json({ ok: false, error: "Only the person who took this snapshot can revoke it" });
  res.json({ ok: await snaps.revokeSnapshot(req.params.snapId) });
});

export default router;
