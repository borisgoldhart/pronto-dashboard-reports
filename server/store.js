import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { kvEnabled, jget, jset, del, hgetJSON, hsetJSON, hdel, hgetallJSON, lpushTrim } from "./kv.js";

/**
 * Dashboard document store — the "DB-light" layer.
 *
 * One JSON document per dashboard (data/dashboards/<guid>.json), an index for
 * listing, and the last 3 versions kept as backups. Every read/write goes
 * through this module — the seam where a real store swaps in.
 *
 * Two backends behind one async interface:
 *   - Redis (when configured) — REQUIRED on serverless so saved dashboards and
 *     share links survive. Layout: doc at `dash:<guid>`, a listing index in the
 *     hash `dash:index` (guid -> summary), backups in the list `dash:bak:<guid>`.
 *   - Filesystem — the original atomic-write store + in-memory index, used for
 *     local dev (unchanged, so existing local dashboards keep working).
 *
 * Dashboard doc shape:
 * { guid, title, refreshInterval, lastRefreshedAt, widgets[],
 *   createdBy: {id,name,email}|null, createdAt, updatedAt, updatedBy }
 *
 * Sharing model (MVP): GUIDs are unguessable capability URLs. The list
 * endpoint only shows YOUR dashboards; anyone with the link can view; only the
 * creator can save/delete. Report data for a dashboard is cached under the
 * d:<guid> partition (snapshot semantics — see report.js).
 */

const DIR = path.resolve(config.cacheDir, "..", "data", "dashboards");
const LEGACY_DATA = path.resolve(config.cacheDir, "..", "data");
const MIGRATED_FLAG = path.join(DIR, ".migrated");

const INDEX_KEY = "dash:index";
const docKey = (guid) => `dash:${guid}`;
const bakKey = (guid) => `dash:bak:${guid}`;

const index = new Map();   // guid -> summary (fs mode only)

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }

const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
const fileFor = (guid) => path.join(DIR, `${guid}.json`);

function indexEntry(doc) {
  return {
    guid: doc.guid, title: doc.title || "Untitled",
    updatedAt: doc.updatedAt || doc.createdAt || null,
    createdBy: doc.createdBy || null,
    widgetCount: Array.isArray(doc.widgets) ? doc.widgets.length : 0,
  };
}

async function writeDoc(doc) {
  if (kvEnabled) {
    await jset(docKey(doc.guid), doc);
    await hsetJSON(INDEX_KEY, doc.guid, indexEntry(doc));
    return;
  }
  ensureDir();
  const f = fileFor(doc.guid);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, f);                        // atomic on the same filesystem
  index.set(doc.guid, indexEntry(doc));
}

/** Keep the last 3 saved versions so an accidental overwrite is recoverable. */
async function backup(guid) {
  try {
    const prev = await getDashboard(guid);
    if (!prev?.widgets?.length) return;
    if (kvEnabled) {
      await lpushTrim(bakKey(guid), prev, 3);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(DIR, `${guid}.${stamp}.bak.json`), JSON.stringify(prev, null, 2));
    fs.readdirSync(DIR)
      .filter((x) => x.startsWith(`${guid}.`) && x.endsWith(".bak.json"))
      .sort().reverse().slice(3)
      .forEach((x) => { try { fs.unlinkSync(path.join(DIR, x)); } catch {} });
  } catch {}
}

/* ---- boot: load index + one-time migration of pre-GUID dashboards (fs only) ---- */

function loadIndex() {
  ensureDir();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json") || f.endsWith(".bak.json") || f.endsWith(".tmp")) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      if (doc?.guid) index.set(doc.guid, indexEntry(doc));
    } catch {}
  }
}

/** Import the old single-dashboard files (data/users/u_<id>/dashboard.default.json
 *  and legacy flat data/dashboard.default.json) as GUID dashboards, once. */
function migrate() {
  if (fs.existsSync(MIGRATED_FLAG)) return;
  ensureDir();
  const imports = [];
  try {
    const usersDir = path.join(LEGACY_DATA, "users");
    if (fs.existsSync(usersDir)) {
      for (const dir of fs.readdirSync(usersDir)) {
        const f = path.join(usersDir, dir, "dashboard.default.json");
        if (!fs.existsSync(f)) continue;
        const m = /^u_(.+)$/.exec(dir);
        imports.push({ file: f, ownerId: m ? m[1] : null });
      }
    }
    const legacyFlat = path.join(LEGACY_DATA, "dashboard.default.json");
    if (fs.existsSync(legacyFlat)) imports.push({ file: legacyFlat, ownerId: null });

    for (const im of imports) {
      try {
        const old = JSON.parse(fs.readFileSync(im.file, "utf8"));
        if (!old?.widgets?.length) continue;             // nothing worth importing
        const doc = {
          guid: crypto.randomUUID(),
          title: old.title || "My Dashboard",
          refreshInterval: old.refreshInterval || "0",
          lastRefreshedAt: old.lastRefreshedAt || null,
          widgets: old.widgets,
          createdBy: im.ownerId ? { id: String(im.ownerId) } : null,
          createdAt: old.updatedAt || new Date().toISOString(),
          updatedAt: old.updatedAt || new Date().toISOString(),
          migratedFrom: im.file,
        };
        ensureDir();
        fs.writeFileSync(fileFor(doc.guid), JSON.stringify(doc, null, 2));
        index.set(doc.guid, indexEntry(doc));
      } catch {}
    }
    fs.writeFileSync(MIGRATED_FLAG, new Date().toISOString());
    if (imports.length) console.log(`  [store] migrated ${imports.length} legacy dashboard(s) to GUID dashboards`);
  } catch (err) {
    console.warn("[store] migration skipped:", err.message);
  }
}

// The filesystem boot work only applies to the local disk backend. On Redis
// (serverless) there is no local dashboards dir to index or migrate.
if (!kvEnabled) {
  migrate();
  loadIndex();
}

/* ---- public API (async) ---- */

export async function listDashboards({ ownerId = null, all = false } = {}) {
  const rows = kvEnabled ? await hgetallJSON(INDEX_KEY) : [...index.values()];
  const mine = all ? rows : rows.filter((r) =>
    r.createdBy?.id != null && ownerId != null && String(r.createdBy.id) === String(ownerId));
  return mine.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export async function getDashboard(guid) {
  if (!isGuid(guid)) return null;
  if (kvEnabled) return (await jget(docKey(guid))) || null;
  try {
    const f = fileFor(guid);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return null; }
}

export async function dashboardExists(guid) {
  if (!isGuid(guid)) return false;
  if (kvEnabled) return (await hgetJSON(INDEX_KEY, guid)) != null;
  return index.has(guid);
}

export async function createDashboard({ title, refreshInterval, identity } = {}) {
  const now = new Date().toISOString();
  const doc = {
    guid: crypto.randomUUID(),
    title: (typeof title === "string" && title.trim()) ? title.trim() : "Untitled dashboard",
    refreshInterval: typeof refreshInterval === "string" ? refreshInterval : "0",
    lastRefreshedAt: null,
    widgets: [],
    createdBy: identity ? { id: identity.id != null ? String(identity.id) : null, name: identity.name || null, email: identity.email || null } : null,
    createdAt: now, updatedAt: now,
  };
  await writeDoc(doc);
  return doc;
}

export async function saveDashboard(guid, patch, updatedBy) {
  const prev = await getDashboard(guid);
  if (!prev) return null;
  await backup(guid);
  const doc = {
    ...prev,
    title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : prev.title,
    refreshInterval: typeof patch.refreshInterval === "string" ? patch.refreshInterval : prev.refreshInterval,
    lastRefreshedAt: patch.lastRefreshedAt !== undefined ? patch.lastRefreshedAt : prev.lastRefreshedAt,
    widgets: Array.isArray(patch.widgets) ? patch.widgets : prev.widgets,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy ? { id: updatedBy.id != null ? String(updatedBy.id) : null, name: updatedBy.name || null } : prev.updatedBy || null,
  };
  await writeDoc(doc);
  return doc;
}

export async function touchRefreshed(guid) {
  const prev = await getDashboard(guid);
  if (!prev) return null;
  const doc = { ...prev, lastRefreshedAt: new Date().toISOString() };
  await writeDoc(doc);   // no backup for a timestamp touch
  return doc;
}

export async function deleteDashboard(guid) {
  if (!(await dashboardExists(guid))) return false;
  if (kvEnabled) {
    try { await del(docKey(guid)); await hdel(INDEX_KEY, guid); return true; }
    catch { return false; }
  }
  try {
    fs.unlinkSync(fileFor(guid));
    index.delete(guid);
    return true;
  } catch { return false; }
}

/** Creator-only edit rule. Env mode (single-user dev box) can edit everything;
 *  ownerless dashboards (pre-migration legacy) are editable by anyone signed in. */
export function canEdit(doc, pronto) {
  if (!doc) return false;
  if (pronto?.mode === "env") return true;
  const owner = doc.createdBy?.id;
  if (owner == null) return true;
  return pronto?.identity?.id != null && String(pronto.identity.id) === String(owner);
}
