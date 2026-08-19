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
 *   createdBy: {id,name,email}|null, createdAt, updatedAt, updatedBy,
 *   members: [{ id, name, email, role:"editor"|"viewer", addedAt, addedBy }] }
 *
 * Sharing model. Two mechanisms, deliberately kept side by side:
 *
 *  1. Named members — invite Pronto users as editors or viewers. A shared
 *     dashboard appears in their list, and the server decides what they may do
 *     from their role, never from anything the client sends.
 *  2. The GUID as an unguessable capability URL, unchanged, so links already
 *     sent out keep working and people without a Pronto login can still view.
 *
 * Members live ON THE DOCUMENT rather than in a join table, and the listing
 * index carries a memberIds array so "dashboards I can see" is one pass over an
 * index we already read. That is a deliberate choice for this scale: one source
 * of truth, nothing to fall out of step, and no migration (a doc with no
 * members is simply unshared). The textbook alternative — a per-user reverse
 * index, `user:<id>:dash` — is the right shape at thousands of dashboards and
 * can be added inside this module without touching a single route.
 *
 * Report data for a dashboard is cached under the d:<guid> partition (snapshot
 * semantics — see report.js), so every member reads the same numbers.
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
    // Denormalised onto the index so listing never has to open every document.
    memberIds: (doc.members || []).map((m) => String(m.id)).filter(Boolean),
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

/**
 * Dashboards this user can see: the ones they own, plus the ones they have been
 * invited to. Each row carries the role, so the list can show it and the client
 * never has to work it out.
 */
export async function listDashboards({ ownerId = null, all = false } = {}) {
  const rows = kvEnabled ? await hgetallJSON(INDEX_KEY) : [...index.values()];
  const me = ownerId == null ? null : String(ownerId);
  const roleOf = (r) => {
    if (r.createdBy?.id == null) return "owner";        // legacy ownerless doc
    if (me != null && String(r.createdBy.id) === me) return "owner";
    if (me != null && (r.memberIds || []).includes(me)) return "member";
    return null;
  };
  const visible = all
    ? rows.map((r) => ({ ...r, role: "owner" }))
    : rows.map((r) => ({ r, role: roleOf(r) })).filter((x) => x.role).map((x) => ({ ...x.r, role: x.role }));
  return visible.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

/** The index only knows "member"; the exact role lives on the document. */
export async function listDashboardsWithRoles({ ownerId = null, all = false } = {}) {
  const rows = await listDashboards({ ownerId, all });
  const me = ownerId == null ? null : String(ownerId);
  return Promise.all(rows.map(async (r) => {
    if (r.role !== "member") return r;
    const doc = await getDashboard(r.guid);
    const m = (doc?.members || []).find((x) => String(x.id) === me);
    return { ...r, role: m?.role === "editor" ? "editor" : "viewer" };
  }));
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
    members: [],
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
    // members are NOT patchable here: sharing changes go through their own
    // endpoints so a widget save can never quietly rewrite who has access.
    members: prev.members || [],
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

/* ---- roles -------------------------------------------------------------------
   One function decides what someone is, and everything else is derived from it,
   so there is a single place to read when asking "why could they do that?". */

/** "owner" | "editor" | "viewer" | null (no access beyond the capability link). */
export function roleFor(doc, pronto) {
  if (!doc) return null;
  if (pronto?.mode === "env") return "owner";          // single-user dev box
  const me = pronto?.identity?.id;
  if (me == null) return null;                          // anonymous link visitor
  const owner = doc.createdBy?.id;
  if (owner == null) return "owner";                    // legacy ownerless doc
  if (String(owner) === String(me)) return "owner";
  const m = (doc.members || []).find((x) => String(x.id) === String(me));
  if (!m) return null;
  return m.role === "editor" ? "editor" : "viewer";
}

export function canEdit(doc, pronto) {
  const r = roleFor(doc, pronto);
  return r === "owner" || r === "editor";
}
/** Editors may invite and remove people too — the owner is not a bottleneck. */
export const canShare = (doc, pronto) => canEdit(doc, pronto);
/** Deleting the whole dashboard, and removing the owner, stay with the owner. */
export const canDelete = (doc, pronto) => roleFor(doc, pronto) === "owner";

const ROLES = new Set(["editor", "viewer"]);

/** Add or promote a member. One role per person: inviting an existing viewer as
 *  an editor promotes them rather than leaving two conflicting rows. */
export async function setMember(guid, { id, name, email, role }, actor) {
  const doc = await getDashboard(guid);
  if (!doc) return { ok: false, error: "Dashboard not found" };
  if (id == null || String(id).trim() === "") return { ok: false, error: "A user id is required" };
  if (!ROLES.has(role)) return { ok: false, error: `Unknown role: ${role}` };
  if (doc.createdBy?.id != null && String(doc.createdBy.id) === String(id)) {
    return { ok: false, error: "That person owns this dashboard already" };
  }
  const members = (doc.members || []).filter((m) => String(m.id) !== String(id));
  members.push({
    id: String(id), name: name || null, email: email || null, role,
    addedAt: new Date().toISOString(),
    addedBy: actor ? { id: actor.id != null ? String(actor.id) : null, name: actor.name || null } : null,
  });
  const next = { ...doc, members, updatedAt: doc.updatedAt };   // sharing isn't a content edit
  await writeDoc(next);
  return { ok: true, members };
}

export async function removeMember(guid, id) {
  const doc = await getDashboard(guid);
  if (!doc) return { ok: false, error: "Dashboard not found" };
  const members = (doc.members || []).filter((m) => String(m.id) !== String(id));
  await writeDoc({ ...doc, members, updatedAt: doc.updatedAt });
  return { ok: true, members };
}
