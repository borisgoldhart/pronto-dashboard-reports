/**
 * Persistent key/value adapter.
 *
 * The dashboard was built to run on a single box with a real filesystem: the
 * report cache, dashboard documents, user sessions and the PKCE pending-login
 * state all live on disk. Serverless hosts (Vercel) give each request a
 * read-only, ephemeral filesystem that is NOT shared between invocations, so
 * that state has to move to an external store.
 *
 * This module is that store. It exposes a tiny async primitive set backed by:
 *   1. Upstash Redis over HTTP/REST  — when KV_REST_API_URL + KV_REST_API_TOKEN
 *      (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) are set. This is
 *      what the Vercel → Upstash Marketplace integration injects, and REST is
 *      the serverless-friendly path (no persistent TCP socket per invocation).
 *   2. A plain Redis URL via ioredis — when REDIS_URL is set (handy for local
 *      testing against a real redis-server, and works on a long-lived VM host).
 *   3. Nothing — `kvEnabled` is false. Callers then keep their original
 *      filesystem behaviour unchanged (local dev / persistent-disk hosting).
 *
 * Values are always stored as strings (we JSON-encode/decode ourselves) so the
 * two client libraries behave identically.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_URL = process.env.REDIS_URL || "";

export const kvEnabled = Boolean((REST_URL && REST_TOKEN) || REDIS_URL);
export const kvBackend = (REST_URL && REST_TOKEN) ? "upstash-rest" : (REDIS_URL ? "ioredis" : "none");

let _adapter = null;      // resolved lazily on first use
let _initPromise = null;

/* ---- low-level adapters: a common shape over the two client libraries ---- */

async function makeUpstash() {
  const { Redis } = await import("@upstash/redis");
  // automaticDeserialization:false -> the client returns raw strings, exactly
  // like ioredis, so our JSON handling is uniform across backends.
  const c = new Redis({ url: REST_URL, token: REST_TOKEN, automaticDeserialization: false });
  return {
    get: (k) => c.get(k),
    set: (k, v, ttlSec) => (ttlSec ? c.set(k, v, { ex: ttlSec }) : c.set(k, v)),
    del: (k) => c.del(k),
    hget: (h, f) => c.hget(h, f),
    hset: (h, f, v) => c.hset(h, { [f]: v }),
    hdel: (h, f) => c.hdel(h, f),
    hgetall: (h) => c.hgetall(h),                       // -> { field: "json" } | null
    lpush: (k, v) => c.lpush(k, v),
    ltrim: (k, a, b) => c.ltrim(k, a, b),
    lrange: (k, a, b) => c.lrange(k, a, b),
    scan: (cursor, match, count) => c.scan(cursor, { match, count }),  // -> [next, keys]
  };
}

async function makeIoredis() {
  const { default: IORedis } = await import("ioredis");
  const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  c.on("error", (e) => console.warn("[kv] redis error:", e.message));
  return {
    get: (k) => c.get(k),
    set: (k, v, ttlSec) => (ttlSec ? c.set(k, v, "EX", ttlSec) : c.set(k, v)),
    del: (k) => c.del(k),
    hget: (h, f) => c.hget(h, f),
    hset: (h, f, v) => c.hset(h, f, v),
    hdel: (h, f) => c.hdel(h, f),
    hgetall: (h) => c.hgetall(h),                       // -> { field: "json" } ({} when absent)
    lpush: (k, v) => c.lpush(k, v),
    ltrim: (k, a, b) => c.ltrim(k, a, b),
    lrange: (k, a, b) => c.lrange(k, a, b),
    scan: (cursor, match, count) => c.scan(cursor, "MATCH", match, "COUNT", count), // -> [next, keys]
  };
}

async function adapter() {
  if (_adapter) return _adapter;
  if (!_initPromise) {
    _initPromise = (kvBackend === "upstash-rest" ? makeUpstash() : makeIoredis())
      .then((a) => (_adapter = a))
      .catch((e) => { _initPromise = null; throw e; });
  }
  return _initPromise;
}

/* ---- JSON primitives used by the rest of the server ---- */

export async function jget(key) {
  const a = await adapter();
  const raw = await a.get(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function jset(key, value, { ttlSec = 0 } = {}) {
  const a = await adapter();
  await a.set(key, JSON.stringify(value), ttlSec > 0 ? ttlSec : undefined);
}

export async function del(key) {
  const a = await adapter();
  await a.del(key);
}

export async function hgetJSON(hkey, field) {
  const a = await adapter();
  const raw = await a.hget(hkey, field);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function hsetJSON(hkey, field, value) {
  const a = await adapter();
  await a.hset(hkey, field, JSON.stringify(value));
}

export async function hdel(hkey, field) {
  const a = await adapter();
  await a.hdel(hkey, field);
}

/** Returns an array of parsed values for every field in the hash. */
export async function hgetallJSON(hkey) {
  const a = await adapter();
  const obj = (await a.hgetall(hkey)) || {};
  const out = [];
  for (const v of Object.values(obj)) {
    if (v == null) continue;
    try { out.push(JSON.parse(v)); } catch {}
  }
  return out;
}

/** Push a value onto the head of a list and trim it to the newest keepN. */
export async function lpushTrim(key, value, keepN) {
  const a = await adapter();
  await a.lpush(key, JSON.stringify(value));
  await a.ltrim(key, 0, Math.max(0, keepN - 1));
}

/** Every key matching `${prefix}*`, gathered across SCAN cursors. */
export async function scanKeys(prefix) {
  const a = await adapter();
  const match = `${prefix}*`;
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await a.scan(cursor, match, 200);
    cursor = String(next);
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}
