import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { kvEnabled, jget, jset, scanKeys, del } from "./kv.js";

/**
 * Report-query cache. Historic Pronto data never changes once a period has
 * passed, so entries are kept permanently (no TTL). Key = SHA256 of the built
 * query URL(s).
 *
 * Two backends behind one async interface:
 *   - Redis (when configured) — required on serverless, and it's what the
 *     anonymous public share view reads from (that view is cache-only).
 *   - Filesystem — the original one-file-per-query store, used for local dev.
 *
 * The interface stays deliberately small so a different backend can drop in.
 */

const PREFIX = "cache:";

function ensureDir() {
  if (!fs.existsSync(config.cacheDir)) fs.mkdirSync(config.cacheDir, { recursive: true });
}

export function keyFor(spec) {
  // Accept a string (e.g. the exact API URL) or an object. Keying on the built URL means
  // any change to the query structure produces a new key — no stale hits after fixes.
  const norm = typeof spec === "string" ? spec : JSON.stringify(spec, Object.keys(spec).sort());
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

function fileFor(key) {
  return path.join(config.cacheDir, `${key}.json`);
}

export async function get(spec) {
  if (!config.cacheEnabled) return null;
  const key = keyFor(spec);
  if (kvEnabled) {
    const entry = await jget(PREFIX + key);
    return entry?.data ?? null;
  }
  try {
    const file = fileFor(key);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw?.data ?? null;
  } catch {
    return null;
  }
}

export async function set(spec, data) {
  if (!config.cacheEnabled) return;
  const key = keyFor(spec);
  const entry = { key, spec, cachedAt: new Date().toISOString(), data };
  if (kvEnabled) {
    try { await jset(PREFIX + key, entry); } catch (err) { console.warn("[cache] redis write failed:", err.message); }
    return;
  }
  try {
    ensureDir();
    fs.writeFileSync(fileFor(key), JSON.stringify(entry));
  } catch (err) {
    console.warn("[cache] write failed:", err.message);
  }
}

export async function stats() {
  if (kvEnabled) {
    try { return { entries: (await scanKeys(PREFIX)).length, backend: "redis" }; }
    catch { return { entries: 0, backend: "redis" }; }
  }
  try {
    ensureDir();
    const files = fs.readdirSync(config.cacheDir).filter((f) => f.endsWith(".json"));
    const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(config.cacheDir, f)).size, 0);
    return { entries: files.length, bytes, dir: config.cacheDir };
  } catch {
    return { entries: 0, bytes: 0, dir: config.cacheDir };
  }
}

export async function clear() {
  if (kvEnabled) {
    try {
      const keys = await scanKeys(PREFIX);
      for (const k of keys) await del(k);
      return keys.length;
    } catch { return 0; }
  }
  try {
    if (!fs.existsSync(config.cacheDir)) return 0;
    const files = fs.readdirSync(config.cacheDir).filter((f) => f.endsWith(".json"));
    for (const f of files) fs.unlinkSync(path.join(config.cacheDir, f));
    return files.length;
  } catch {
    return 0;
  }
}
