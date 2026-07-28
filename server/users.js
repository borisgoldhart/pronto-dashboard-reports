import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { authMode, getIdentity, identityKey, prontoLogin, prontoVerifyToken, pkcePair, prontoPkceStart, prontoPkceExchange } from "./session.js";
import { kvEnabled, jget, jset, del } from "./kv.js";

/**
 * Per-user sessions.
 *
 * Each browser gets an httpOnly `pronto_sid` cookie mapped to that user's own
 * Pronto bearer token + session cookie + identity. Every report query runs with
 * the USER'S credentials, so results are permission-scoped to them, and their
 * user id keys their dashboards and cache partition.
 *
 * Persistence has two backends:
 *   - Redis (when configured) — REQUIRED on serverless: the in-memory Map is
 *     per-instance and empty on every cold start, so sessions (and the PKCE
 *     pending-login state, whose start/poll can hit different instances) must
 *     live in the shared store. Keys: `sess:<sid>`, `broker:<pid>`, both TTL'd.
 *   - In-memory Map + .cache/.sessions.json — the original store, used for
 *     local dev (a restart doesn't log the whole team out).
 */

const SESSIONS_FILE = path.join(config.cacheDir, ".sessions.json");
const COOKIE_NAME = "pronto_sid";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_AGE_SEC = Math.floor(MAX_AGE_MS / 1000);
const sessKey = (sid) => `sess:${sid}`;
const brokerKey = (pid) => `broker:${pid}`;

const sessions = new Map();       // fs mode only
if (!kvEnabled) (function load() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      const now = Date.now();
      for (const [sid, s] of Object.entries(raw)) {
        if (s?.token && now - (s.createdAt || 0) < MAX_AGE_MS) sessions.set(sid, s);
      }
    }
  } catch {}
})();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(config.cacheDir)) fs.mkdirSync(config.cacheDir, { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
    } catch {}
  }, 250);
}

/** Remaining TTL (seconds) for an absolute 30-day-from-creation expiry. */
function remainingTtlSec(createdAt) {
  const left = Math.floor((MAX_AGE_MS - (Date.now() - (createdAt || 0))) / 1000);
  return left > 0 ? left : 1;
}

function parseSid(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)pronto_sid=([^;]+)/);
  return m ? m[1] : null;
}

export async function getSession(req) {
  const sid = parseSid(req);
  if (!sid) return null;
  if (kvEnabled) {
    const s = await jget(sessKey(sid));
    if (!s) return null;
    if (Date.now() - (s.createdAt || 0) > MAX_AGE_MS) { await del(sessKey(sid)); return null; }
    return { sid, ...s };
  }
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - (s.createdAt || 0) > MAX_AGE_MS) { sessions.delete(sid); persist(); return null; }
  s.lastSeen = Date.now();
  return { sid, ...s };
}

export async function createSession({ token, cookie, identity, refreshToken, expiresIn }) {
  const sid = crypto.randomBytes(24).toString("hex");
  const s = {
    token, cookie: cookie || "", identity: identity || null,
    refreshToken: refreshToken || null,
    tokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    createdAt: Date.now(), lastSeen: Date.now(),
  };
  if (kvEnabled) {
    await jset(sessKey(sid), s, { ttlSec: MAX_AGE_SEC });
  } else {
    sessions.set(sid, s);
    persist();
  }
  return sid;
}

export async function updateSession(sid, patch) {
  if (kvEnabled) {
    const s = await jget(sessKey(sid));
    if (!s) return;
    Object.assign(s, patch);
    await jset(sessKey(sid), s, { ttlSec: remainingTtlSec(s.createdAt) });
    return;
  }
  const s = sessions.get(sid);
  if (s) { Object.assign(s, patch); persist(); }
}

export async function destroySession(sid) {
  if (kvEnabled) { await del(sessKey(sid)); return; }
  sessions.delete(sid);
  persist();
}

/** Set-Cookie header value for the session id (or for clearing it). */
export function sidCookie(sid, { destroy = false } = {}) {
  const base = `${COOKIE_NAME}=${destroy ? "" : sid}; Path=/; HttpOnly; SameSite=Lax`;
  return destroy ? `${base}; Max-Age=0` : `${base}; Max-Age=${MAX_AGE_SEC}`;
}

/**
 * Env-fallback bypass. With .env credentials configured, every request is
 * auto-signed-in as that identity — which made Logout look like a no-op (the
 * page reloads straight back into env mode). Logging out now sets this cookie
 * so THIS BROWSER sees the login screen; any successful login clears it.
 * Fresh browsers / curl without the cookie still get the env fallback.
 */
const BYPASS_COOKIE = "pronto_envbypass";
export function envBypassCookie(set) {
  const base = `${BYPASS_COOKIE}=${set ? "1" : ""}; Path=/; HttpOnly; SameSite=Lax`;
  return set ? `${base}; Max-Age=${MAX_AGE_SEC}` : `${base}; Max-Age=0`;
}
function hasEnvBypass(req) {
  return /(?:^|;\s*)pronto_envbypass=1/.test(String(req.headers.cookie || ""));
}

/** The env-credential fallback must not auto-sign-in the whole network: by
 *  default it only applies to loopback requests (the dev box's own browser).
 *  Uses the raw socket address — proxy headers are spoofable.
 *
 *  IMPORTANT: on a serverless / reverse-proxied host (Vercel, etc.) the Node
 *  process sits behind a proxy, so req.socket.remoteAddress is ALWAYS an
 *  internal/loopback address — the "local" check would fail OPEN and sign every
 *  visitor in as the env identity. So on those hosts "local" is treated as
 *  "off": the env fallback only ever applies when explicitly set to "all". */
function isServerless() {
  return Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
}
function envFallbackApplies(req) {
  if (config.envFallback === "off") return false;
  if (config.envFallback === "all") return true;
  if (isServerless()) return false;                    // "local" is unsafe behind a proxy
  const a = String(req.socket?.remoteAddress || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** Stable per-user key for storage/cache partitioning (mirrors session.identityKey). */
export function userKeyOf(identity) {
  return identity?.id ? `u:${identity.id}` : identity?.email ? `e:${identity.email}` : null;
}

/** Log a user in with a pasted token OR email+password. */
export async function loginUser({ token, email, password } = {}) {
  let tok = String(token || "").trim().replace(/^Bearer\s+/i, "");
  let cookie = "", refreshToken = null, expiresIn = null;

  if (!tok) {
    if (!email || !password) return { ok: false, status: 400, error: "Enter your email and password, or paste an API token." };
    const r = await prontoLogin(String(email).trim(), String(password));
    if (!r.ok) return { ok: false, status: r.status || 401, error: r.error || "Login failed" };
    tok = r.token || "";
    cookie = r.cookie || "";
    refreshToken = r.refreshToken || null;
    expiresIn = r.expiresIn || null;
    if (!tok) return { ok: false, status: 502, error: "Pronto accepted the login but returned no token" };
  }

  const v = await prontoVerifyToken(tok);
  if (!v.ok) return { ok: false, status: v.status || 401, error: v.error || "Token was rejected by havaspronto.com" };
  if (!cookie) cookie = v.cookie || "";
  if (!v.identity) return { ok: false, status: 502, error: "Could not resolve your Pronto user id from /me" };

  const sid = await createSession({ token: tok, cookie, identity: v.identity, refreshToken, expiresIn });
  return { ok: true, sid, identity: v.identity };
}

/* ---- PKCE broker login ("Sign in with HavasPronto") -------------------------
   The user logs in on the Pronto site itself (SSO included); the dashboard never
   sees credentials. We keep the code_verifier server-side, hand the browser a
   short-lived pending id (pid), and poll the exchange endpoint until the site
   reports the login is complete. The pending state must be shared across
   serverless instances (start and poll can land on different ones), so it lives
   in Redis when configured. */

const pendingBroker = new Map();               // fs mode only
const BROKER_TTL_MS = 10 * 60 * 1000;          // matches the site's transaction lifetime
const BROKER_TTL_SEC = Math.floor(BROKER_TTL_MS / 1000);

function gcBroker() {
  const now = Date.now();
  for (const [k, v] of pendingBroker) if (now - v.createdAt > BROKER_TTL_MS) pendingBroker.delete(k);
}

async function putPending(pid, rec) {
  if (kvEnabled) return jset(brokerKey(pid), rec, { ttlSec: BROKER_TTL_SEC });
  pendingBroker.set(pid, rec);
}
async function getPending(pid) {
  if (kvEnabled) return jget(brokerKey(pid));
  return pendingBroker.get(pid) || null;
}
async function dropPending(pid) {
  if (kvEnabled) return del(brokerKey(pid));
  pendingBroker.delete(pid);
}

/** Begin a broker login. Returns { ok, pid, loginUrl }. */
export async function brokerStart(returnUrl) {
  if (!kvEnabled) gcBroker();
  const { verifier, challenge, state } = pkcePair();
  const r = await prontoPkceStart(challenge, state, returnUrl);
  if (!r.ok) return { ok: false, status: r.status || 502, error: r.error || "Could not start Pronto sign-in" };
  const pid = crypto.randomBytes(18).toString("hex");
  await putPending(pid, { verifier, state, txnId: r.txnId, createdAt: Date.now() });
  return { ok: true, pid, loginUrl: r.loginUrl };
}

/** Poll a broker login. Pending -> {ok,pending}; success -> {ok,sid,identity}. */
export async function brokerPoll(pid) {
  const p = await getPending(String(pid || ""));
  if (!p) return { ok: false, status: 410, error: "Sign-in attempt expired — start again." };
  if (Date.now() - p.createdAt > BROKER_TTL_MS) {
    await dropPending(pid);
    return { ok: false, status: 410, error: "Sign-in attempt timed out — start again." };
  }
  const r = await prontoPkceExchange(p.txnId, p.state, p.verifier);
  if (r.pending) return { ok: true, pending: true, retryAfter: r.retryAfter || null };
  if (!r.ok) {
    await dropPending(pid);
    return { ok: false, status: r.status || 400, error: r.error || "Pronto sign-in failed — start again." };
  }
  await dropPending(pid);
  const v = await prontoVerifyToken(r.token);
  if (!v.ok || !v.identity) return { ok: false, status: 502, error: "Token issued but /me verification failed" };
  const sid = await createSession({
    token: r.token,
    cookie: r.cookie || v.cookie || "",
    identity: v.identity,
    refreshToken: r.refreshToken,
    expiresIn: r.expiresIn,
  });
  return { ok: true, sid, identity: v.identity };
}

/**
 * Express middleware — attaches req.pronto:
 *   { mode: "session"|"env"|"none", sid, auth: {token,cookie,onCookieRefresh}|null, identity, key }
 * mode "env" = legacy single-identity fallback from .env credentials.
 */
export async function attachUser(req, _res, next) {
  const s = await getSession(req);
  if (s) {
    req.pronto = {
      mode: "session",
      sid: s.sid,
      auth: {
        token: s.token,
        cookie: s.cookie,
        onCookieRefresh: (c) => { updateSession(s.sid, { cookie: c }).catch(() => {}); },
        onTokenRefresh: (t, c) => { updateSession(s.sid, { token: t, ...(c ? { cookie: c } : {}) }).catch(() => {}); },
      },
      identity: s.identity,
      key: userKeyOf(s.identity) || "anon",
    };
    return next();
  }
  if (authMode() !== "none" && !hasEnvBypass(req) && envFallbackApplies(req)) {
    let identity = null, key = "anon";
    try { identity = await getIdentity(); key = await identityKey(); } catch {}
    req.pronto = { mode: "env", sid: null, auth: null, identity, key };
    return next();
  }
  req.pronto = { mode: "none", sid: null, auth: null, identity: null, key: "anon" };
  next();
}
