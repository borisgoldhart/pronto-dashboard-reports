import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Pronto auth-token lifecycle.
 *
 * Flow (per Pronto API docs, "Bearer Auth"):
 *   POST {base}/v2/api/auth/login  { email, password }  -> { token }
 *   Then send  Authorization: Bearer <token>  on API calls.
 *   POST {base}/v2/api/auth/me     (Bearer)              -> verifies the token.
 *
 * Precedence of credentials:
 *   1. PRONTO_BEARER_TOKEN  — a manually supplied token (no login performed)
 *   2. PRONTO_EMAIL + PRONTO_PASSWORD — logged in on demand, token cached + refreshed
 *   3. PRONTO_COOKIE — legacy same-origin session (fallback)
 */

const LOGIN_PATH = "/v2/api/auth/login";
const ME_PATH = "/v2/api/auth/me";
const TOKEN_FILE = path.join(config.cacheDir, ".token.json");

let mem = { token: null, obtainedAt: 0 };

// ---- token persistence (survives restarts; token is not historic data, but
// caching it avoids a login on every boot) ----
function loadPersisted() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (raw?.token) mem = raw;
    }
  } catch {}
}
function persist() {
  try {
    if (!fs.existsSync(config.cacheDir)) fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(mem));
  } catch {}
}
loadPersisted();

export function authMode() {
  if (config.bearerToken) return "bearer-manual";
  if (config.email && config.password) return "login";
  if (config.cookie) return "cookie";
  return "none";
}

/** Capture the Pronto session cookie(s) from a login response.
 *  The reporting endpoint (/v2/ajax/reports/...) is session-cookie based and is an
 *  order of magnitude faster with the session cookie than when it has to exchange a
 *  bearer token for a session on every request. Returns a "name=value; name=value"
 *  string suitable for a Cookie header, or "". */
function captureCookies(res) {
  try {
    const list = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    const pairs = list
      .map((c) => c.split(";")[0].trim())      // keep just name=value
      .filter((p) => p && /=/.test(p) && !/=deleted$/i.test(p));
    // dedupe by cookie name, last wins
    const byName = new Map();
    for (const p of pairs) byName.set(p.split("=")[0], p);
    return [...byName.values()].join("; ");
  } catch {
    return "";
  }
}

/** Try to extract a token from various plausible response shapes. */
function extractToken(body) {
  if (!body || typeof body !== "object") return null;
  return (
    body.token ||
    body.access_token ||
    body.accessToken ||
    body.data?.token ||
    body.data?.access_token ||
    body.result?.token ||
    null
  );
}

/* ---- stateless helpers (shared by env-credential mode and per-user sessions) ---- */

/** Exchange email+password for a token via POST /v2/api/auth/login. No global state. */
export async function prontoLogin(email, password) {
  const url = `${config.prontoBaseUrl}${LOGIN_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: body?.message || body?.error || `HTTP ${res.status}` };
    }
    const token = extractToken(body);
    const cookie = captureCookies(res);
    if (!token && !cookie) return { ok: false, status: res.status, error: "Login succeeded but returned no token" };
    return {
      ok: true, status: res.status, token, cookie,
      refreshToken: body?.refresh_token || null,      // returned by the OAuth-style endpoints
      expiresIn: Number(body?.expires_in) || null,
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Refresh an access token. Contract confirmed from the Pronto Time Tracker app:
 *  POST {base}/v2/api/auth/refresh, authorised by the CURRENT access token,
 *  body { grant_type: "refresh_token" } -> { access_token, refresh_token?, expires_in }.
 *  Keep the old refresh_token when none is returned. */
export async function prontoRefreshToken(accessToken) {
  if (!accessToken) return { ok: false, status: 0, error: "No token to refresh" };
  try {
    const res = await fetch(`${config.prontoBaseUrl}/v2/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) return { ok: false, status: res.status, error: body?.message || body?.error || `HTTP ${res.status}` };
    const token = body?.access_token || extractToken(body);
    if (!token) return { ok: false, status: res.status, error: "Refresh returned no access_token" };
    return { ok: true, status: res.status, token, refreshToken: body?.refresh_token || null, expiresIn: Number(body?.expires_in) || null, cookie: captureCookies(res) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Verify a bearer token via POST /v2/api/auth/me. Returns identity + a fresh
 *  session cookie (the reporting endpoint's fast path). No global state. */
export async function prontoVerifyToken(token) {
  if (!token) return { ok: false, status: 0, error: "No token supplied" };
  try {
    const res = await fetch(`${config.prontoBaseUrl}${ME_PATH}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: body?.message || body?.error || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, identity: extractIdentity(body), cookie: captureCookies(res) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/* ---- PKCE broker ("Sign in with HavasPronto") ----------------------------------
   Contract confirmed from the Pronto Time Tracker app (docs/reference/time-tracker-auth.md):
     POST {base}/api/v2/app/pkce/start    { code_challenge, state }        -> { txn_id, login_url }
     user logs in at {base}/v2/?txn_id=…  (site handles SSO)
     POST {base}/api/v2/app/pkce/exchange { txn_id, state, code_verifier } ->
       200 { access_token, refresh_token, expires_in }
       401 USER_NOT_AUTHENTICATED  = user hasn't finished logging in yet (poll again)
       400 TRANSACTION_EXPIRED / INVALID_CODE_VERIFIER = fatal, restart
       429 + Retry-After           = back off
------------------------------------------------------------------------------- */

/** Generate a PKCE pair + CSRF state (S256, per RFC 7636). */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomUUID();
  return { verifier, challenge, state };
}

export async function prontoPkceStart(challenge, state, returnUrl) {
  const url = config.pkceStartUrl || `${config.prontoBaseUrl}/api/v2/app/pkce/start`;
  try {
    // redirect_uri/return_url: IGNORED by the broker today (verified live 22 Jul 2026 —
    // it always returns to its own pages). Sent anyway so that if the Pronto team adds
    // whitelisted web return URLs, the popup will land on our self-closing /auth/callback
    // with no dashboard change needed.
    const payload = { code_challenge: challenge, state };
    if (returnUrl) { payload.redirect_uri = returnUrl; payload.return_url = returnUrl; }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok || !body?.txn_id) {
      return { ok: false, status: res.status, error: body?.error || body?.message || `PKCE start failed (HTTP ${res.status})` };
    }
    // Use the NORMALISED direct URL like the Time Tracker does — NOT body.login_url.
    // The site's login_url routes via the login method picker even when the user
    // already has a Pronto session; the direct {base}/v2/?txn_id=… form completes
    // instantly for signed-in users (verified live 22 Jul 2026), so for a user who
    // is already in Pronto the popup opens and auto-closes in a couple of seconds.
    const loginUrl = config.brokerLoginUrl
      ? `${config.brokerLoginUrl}${config.brokerLoginUrl.includes("?") ? "&" : "?"}txn_id=${encodeURIComponent(body.txn_id)}`
      : `${config.prontoBaseUrl}/v2/?txn_id=${encodeURIComponent(body.txn_id)}`;
    return { ok: true, status: res.status, txnId: body.txn_id, loginUrl };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

export async function prontoPkceExchange(txnId, state, verifier) {
  const url = config.pkceExchangeUrl || `${config.prontoBaseUrl}/api/v2/app/pkce/exchange`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ txn_id: txnId, state, code_verifier: verifier }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (res.status === 401) return { ok: false, pending: true, status: 401 };           // user mid-login
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after")) || 10;
      return { ok: false, pending: true, status: 429, retryAfter: ra };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, code: body?.code, error: body?.error || body?.message || `PKCE exchange failed (HTTP ${res.status})` };
    }
    const token = body?.access_token || extractToken(body);
    if (!token) return { ok: false, status: res.status, error: "Exchange succeeded but returned no access_token" };
    return {
      ok: true, status: res.status, token,
      refreshToken: body?.refresh_token || null,
      expiresIn: Number(body?.expires_in) || null,
      cookie: captureCookies(res),
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Perform a fresh login. Returns { ok, token?, status, error? }. */
export async function login() {
  if (!config.email || !config.password) {
    return { ok: false, status: 0, error: "PRONTO_EMAIL / PRONTO_PASSWORD not set" };
  }
  const url = `${config.prontoBaseUrl}${LOGIN_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: body?.message || body?.error || `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    const token = extractToken(body);
    let cookie = captureCookies(res);
    if (!token && !cookie) {
      return { ok: false, status: res.status, error: `Login 200 but no token or session cookie found. Keys: ${Object.keys(body || {}).join(",")}` };
    }
    // Fallback: if login didn't set a session cookie but we have a token, bootstrap a
    // session by calling /me with the bearer — its response typically sets the cookie
    // the reporting endpoint wants (the fast path).
    if (!cookie && token) {
      try {
        const meRes = await fetch(`${config.prontoBaseUrl}${ME_PATH}`, {
          method: "POST",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        });
        cookie = captureCookies(meRes);
      } catch {}
    }
    mem = { token, cookie, obtainedAt: Date.now() };
    persist();
    return { ok: true, status: res.status, token, hasCookie: Boolean(cookie) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Get a usable bearer token, logging in if necessary. */
export async function getToken({ forceRefresh = false } = {}) {
  if (config.bearerToken) return config.bearerToken; // manual override
  if (!forceRefresh && mem.token) return mem.token;
  const r = await login();
  return r.ok ? r.token : null;
}

/** Get the cached Pronto session cookie (from login), refreshing via login if needed. */
export async function getSessionCookie({ forceRefresh = false } = {}) {
  if (config.cookie) return config.cookie;               // manual override
  if (!forceRefresh && mem.cookie) return mem.cookie;
  const r = await login();
  return r.ok ? mem.cookie : null;
}

/** Clear the cached token + cookie (call on 401 so the next request re-logs-in). */
export function invalidate() {
  mem = { token: null, cookie: null, obtainedAt: 0 };
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch {}
}

/** Build auth headers for an API request, obtaining/refreshing a token as needed. */
export async function resolveAuthHeaders({ forceRefresh = false } = {}) {
  const headers = {};
  const mode = authMode();
  if (mode === "cookie") {
    headers["Cookie"] = config.cookie;
    return headers;
  }
  // Login mode: send BOTH the session cookie (fast path for the reporting endpoint)
  // and the bearer token. The cookie avoids the per-request token->session exchange
  // that makes bearer-only calls 10-20x slower.
  const token = await getToken({ forceRefresh });
  const cookie = await getSessionCookie({ forceRefresh });
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// ---- current Pronto identity -------------------------------------------------
// The reporting API returns permission-scoped data, so every cached result belongs to
// the identity that fetched it. We record that identity per widget and include it in
// the cache key so two users can never see each other's cached rows.
let identity = null;

function extractIdentity(body) {
  if (!body || typeof body !== "object") return null;
  const src = body.data || body.user || body;
  // NB: the live /v2/api/auth/me returns `userid` (confirmed in the Time Tracker
  // app's MeResponse struct) — keep it first in the chain.
  const id = src.userid ?? src.id ?? src.user_id ?? src.userId ?? src.uid ?? null;
  const email = src.email ?? src.user_email ?? null;
  const name = src.name ?? src.full_name ??
    ([src.first_name, src.last_name].filter(Boolean).join(" ") || null);
  if (id == null && !email) return null;
  return { id: id != null ? String(id) : null, email: email || null, name: name || null };
}

/** The Pronto user the proxy is authenticated as (cached). */
export async function getIdentity({ refresh = false } = {}) {
  if (identity && !refresh) return identity;
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${config.prontoBaseUrl}${ME_PATH}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    identity = extractIdentity(body);
    return identity;
  } catch { return null; }
}

/** Stable key for cache partitioning — never share cached rows across users. */
export async function identityKey() {
  const me = await getIdentity();
  return me?.id ? `u:${me.id}` : me?.email ? `e:${me.email}` : "anon";
}

/** Verify the current token via /v2/api/auth/me. Returns { ok, status, user?, error? }. */
export async function verifyMe() {
  const mode = authMode();
  if (mode === "none") return { ok: false, status: 0, error: "No credentials configured" };
  if (mode === "cookie") return { ok: true, status: 0, note: "cookie mode — /me skipped (verify via a report query)" };

  const token = await getToken();
  if (!token) return { ok: false, status: 0, error: "Could not obtain a token (login failed)" };

  const url = `${config.prontoBaseUrl}${ME_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      if (res.status === 401) invalidate();
      return { ok: false, status: res.status, error: body?.message || `HTTP ${res.status}` };
    }
    const user = body?.email || body?.data?.email || body?.user?.email || body?.name || "verified";
    return { ok: true, status: res.status, user };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}
