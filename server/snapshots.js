import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { kvEnabled, jget, jset, del, hsetJSON, hdel, hgetallJSON } from "./kv.js";
import { freezeSpec } from "./dates.js";
import { comparisonRange } from "./query.js";

/**
 * Frozen dashboard snapshots — the "locked-in share link".
 *
 * A share link to a live dashboard (?d=<guid>) is a *view* of moving data: the
 * anonymous viewer has no credentials, so the server can only serve rows that
 * happen to be cached, and cache keys move whenever a widget's date preset
 * rolls. Hence the failure this exists to fix: a link that worked on Monday
 * showed "no data" by Wednesday.
 *
 * A snapshot (?s=<snapId>) is a *copy*. Taking one:
 *   1. pins every widget's dates to absolute values (see dates.freezeSpec), and
 *   2. stores the fetched, shaped payload for each widget alongside the spec.
 *
 * Nothing about it is derived at view time, so nothing about it can drift. It
 * survives a cache clear, a preset change, a widget being deleted from the
 * parent dashboard, and the parent dashboard itself being deleted. Snapshots
 * are written without a TTL and are never rewritten — only created and revoked.
 *
 * Keys:
 *   snap:<snapId>              the snapshot document (meta + frozen widgets)
 *   snapdata:<snapId>:<wid>    one widget's stored payload
 *   snap:index:<guid>          hash of snapId -> summary, for the owner's list
 *
 * Local dev (no Redis) mirrors this on disk under data/snapshots/, so the
 * feature is testable without provisioning a store.
 */

const DIR = path.resolve(config.cacheDir, "..", "data", "snapshots");

const docKey = (id) => `snap:${id}`;
const dataKey = (id, wid) => `snapdata:${id}:${wid}`;
const indexKey = (guid) => `snap:index:${guid}`;

const isSnapId = (s) => /^[0-9a-f]{32}$/i.test(String(s || ""));
const safeWid = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
const fileFor = (name) => path.join(DIR, `${name}.json`);

/* ---- backend-agnostic primitives ---------------------------------------- */

async function put(key, value) {
  if (kvEnabled) return jset(key, value);          // no TTL: snapshots are permanent
  ensureDir();
  const f = fileFor(key.replace(/:/g, "_"));
  fs.writeFileSync(f + ".tmp", JSON.stringify(value));
  fs.renameSync(f + ".tmp", f);
}

async function take(key) {
  if (kvEnabled) return jget(key);
  try {
    const f = fileFor(key.replace(/:/g, "_"));
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  } catch { return null; }
}

async function drop(key) {
  if (kvEnabled) return del(key);
  try { fs.unlinkSync(fileFor(key.replace(/:/g, "_"))); } catch {}
}

/* ---- public API ---------------------------------------------------------- */

/**
 * Create the snapshot shell: metadata plus every widget's spec frozen to
 * absolute dates. No data yet — the caller fills widgets in one at a time via
 * captureWidget(), which keeps each HTTP request down to a single upstream
 * report query and safely inside the serverless execution limit.
 */
export async function createSnapshot(dash, identity, { note = "" } = {}) {
  const snapId = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const widgets = (dash.widgets || []).map((w) => ({
    ...w,
    spec: freezeSpec(w.spec || {}, { comparisonRange, now }),
  }));
  const doc = {
    snapId,
    guid: dash.guid,
    title: dash.title || "Untitled dashboard",
    note: String(note || "").slice(0, 300),
    takenAt: now.toISOString(),
    takenBy: identity ? { id: identity.id != null ? String(identity.id) : null, name: identity.name || null, email: identity.email || null } : null,
    refreshInterval: "0",                       // a snapshot never auto-refreshes
    status: "building",
    widgets,
    widgetCount: widgets.length,
    capturedCount: 0,
    errors: [],
  };
  await put(docKey(snapId), doc);
  await addToIndex(doc);
  return doc;
}

export async function getSnapshot(snapId) {
  if (!isSnapId(snapId)) return null;
  return (await take(docKey(snapId))) || null;
}

/** The stored payload for one widget of a snapshot (null when not captured). */
export async function getSnapshotData(snapId, widgetId) {
  if (!isSnapId(snapId)) return null;
  return (await take(dataKey(snapId, safeWid(widgetId)))) || null;
}

/**
 * Run one widget's frozen spec and store the result. `runner` is injected so
 * this module stays free of route/auth concerns: it receives the frozen spec
 * and returns the shaped payload (see query.runWidgetQuery).
 */
export async function captureWidget(snapId, widgetId, runner) {
  const doc = await getSnapshot(snapId);
  if (!doc) return { ok: false, status: 404, error: "Snapshot not found" };
  if (doc.status === "revoked") return { ok: false, status: 410, error: "Snapshot revoked" };

  const widget = (doc.widgets || []).find((w) => String(w.id) === String(widgetId));
  if (!widget) return { ok: false, status: 404, error: "Widget not in snapshot" };

  const result = await runner(widget.spec);

  // Store the payload either way: a widget that genuinely errored should show
  // that same error to every viewer rather than an ambiguous blank tile.
  const { raw, ...payload } = result || {};
  await put(dataKey(snapId, safeWid(widgetId)), {
    widgetId: String(widgetId),
    capturedAt: new Date().toISOString(),
    payload: { ...payload, cached: undefined, snapshot: true },
  });

  const already = (doc.captured || []).includes(String(widgetId));
  const captured = already ? doc.captured : [...(doc.captured || []), String(widgetId)];
  const errors = result?.ok
    ? (doc.errors || []).filter((e) => e.widgetId !== String(widgetId))
    : [...(doc.errors || []).filter((e) => e.widgetId !== String(widgetId)),
       { widgetId: String(widgetId), error: result?.error || "Query failed" }];

  const next = { ...doc, captured, capturedCount: captured.length, errors };
  await put(docKey(snapId), next);
  return { ok: true, capturedCount: next.capturedCount, widgetCount: next.widgetCount, error: result?.ok ? null : (result?.error || null) };
}

/** Mark a snapshot readable. Returns the finished document. */
export async function finalizeSnapshot(snapId) {
  const doc = await getSnapshot(snapId);
  if (!doc) return null;
  const next = { ...doc, status: "ready", readyAt: new Date().toISOString() };
  await put(docKey(snapId), next);
  await addToIndex(next);
  return next;
}

/**
 * Revoke a snapshot: the link stops working and the stored data is removed.
 * This is the only destructive operation on a snapshot — there is deliberately
 * no edit path, so a link you have sent can never quietly change underneath you.
 */
export async function revokeSnapshot(snapId) {
  const doc = await getSnapshot(snapId);
  if (!doc) return false;
  for (const w of doc.widgets || []) await drop(dataKey(snapId, safeWid(w.id)));
  await drop(docKey(snapId));
  if (kvEnabled) { try { await hdel(indexKey(doc.guid), snapId); } catch {} }
  else await removeFromFileIndex(doc.guid, snapId);
  return true;
}

/** Snapshots taken from a given dashboard, newest first. */
export async function listSnapshots(guid) {
  const rows = kvEnabled ? await hgetallJSON(indexKey(guid)) : await readFileIndex(guid);
  return rows.sort((a, b) => String(b.takenAt || "").localeCompare(String(a.takenAt || "")));
}

function summary(doc) {
  return {
    snapId: doc.snapId, guid: doc.guid, title: doc.title, note: doc.note || "",
    takenAt: doc.takenAt, takenBy: doc.takenBy, status: doc.status,
    widgetCount: doc.widgetCount, capturedCount: doc.capturedCount || 0,
  };
}

async function addToIndex(doc) {
  if (kvEnabled) { try { await hsetJSON(indexKey(doc.guid), doc.snapId, summary(doc)); } catch {} return; }
  const rows = (await readFileIndex(doc.guid)).filter((r) => r.snapId !== doc.snapId);
  rows.push(summary(doc));
  await put(`snapidx:${doc.guid}`, rows);
}

async function readFileIndex(guid) {
  const rows = await take(`snapidx:${guid}`);
  return Array.isArray(rows) ? rows : [];
}

async function removeFromFileIndex(guid, snapId) {
  const rows = (await readFileIndex(guid)).filter((r) => r.snapId !== snapId);
  await put(`snapidx:${guid}`, rows);
}

/** Does this identity own the snapshot (or the dashboard it came from)? */
export function canManage(doc, pronto) {
  if (!doc) return false;
  if (pronto?.mode === "env") return true;
  const owner = doc.takenBy?.id;
  if (owner == null) return true;
  return pronto?.identity?.id != null && String(pronto.identity.id) === String(owner);
}
