import { config } from "./config.js";

/**
 * Pronto user lookup, for the dashboard sharing picker.
 *
 * Two things about this endpoint are worth knowing before touching it:
 *
 *  1. It is JSON:API, and it MEANS it. Ask with `Accept: application/json` and
 *     it answers HTTP 406 "capable of generating only content not acceptable
 *     according to the Accept headers" rather than any data. It needs
 *     `application/vnd.api+json`.
 *  2. It has to be called server-side. The browser cannot send the user's
 *     Pronto credentials cross-origin, so this proxies the search using the
 *     caller's own session — meaning the results are already scoped to whoever
 *     is signed in, exactly like the reporting API.
 */

const PATH = "/v2/api/users";
const ACCEPT = "application/vnd.api+json";

/** Attempt with one set of auth headers. */
async function attempt(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: ACCEPT, "X-Requested-With": "XMLHttpRequest", ...headers },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    try { return { ok: true, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, error: "Non-JSON response from the user search" }; }
  } catch (err) {
    return { ok: false, status: 0, error: err.name === "AbortError" ? "User search timed out" : String(err) };
  } finally { clearTimeout(t); }
}

/**
 * Search active Pronto users by name or email.
 * Deleted and suspended accounts are excluded at the source — there is no point
 * offering someone you cannot actually share with.
 */
export async function searchUsers(q, { auth = null, limit = 8, timeoutMs = 15000 } = {}) {
  const term = String(q || "").trim();
  if (term.length < 2) return { ok: true, users: [] };

  const p = new URLSearchParams();
  p.append("filter[access_not_in][]", "deleted");
  p.append("filter[access_not_in][]", "suspended");
  p.set("filter[search]", term);
  p.set("page[number]", "1");
  p.set("page[size]", String(limit));
  p.set("page[per_page]", String(limit));
  const url = `${config.prontoBaseUrl}${PATH}?${p.toString()}`;

  // Cookie first (the fast path the reporting client also prefers), bearer after.
  const strategies = [];
  if (auth?.cookie) strategies.push({ Cookie: auth.cookie });
  if (auth?.token) strategies.push({ Authorization: `Bearer ${auth.token}` });
  if (!strategies.length) return { ok: false, status: 401, authRequired: true, error: "Not signed in" };

  let last = null;
  for (const headers of strategies) {
    last = await attempt(url, headers, timeoutMs);
    if (last.ok) break;
  }
  if (!last?.ok) return { ok: false, status: last?.status || 502, error: last?.error || "User search failed" };

  const rows = Array.isArray(last.data?.data) ? last.data.data : [];
  const users = rows.map((r) => {
    const a = r.attributes || {};
    return {
      id: String(a.userid ?? r.id ?? ""),
      name: a.name || null,
      email: a.email || null,
      office: a.client || null,        // their office, for telling two Richards apart
      avatarUrl: a.avatarUrl || null,
    };
  }).filter((u) => u.id);

  return { ok: true, users };
}
