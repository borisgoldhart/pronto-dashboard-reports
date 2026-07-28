import { Router } from "express";
import { config } from "../config.js";
import { authMode } from "../session.js";
import { loginUser, getSession, destroySession, sidCookie, envBypassCookie, brokerStart, brokerPoll } from "../users.js";
import { fetchReport } from "../pronto.js";

const router = Router();

/**
 * Who am I / how is auth set up. req.pronto is attached by the attachUser
 * middleware (see users.js):
 *   mode "session" — the browser holds a per-user session (multi-user mode)
 *   mode "env"     — legacy single-identity fallback from .env credentials
 *   mode "none"    — nobody is signed in and no fallback exists -> login required
 */
router.get("/status", (req, res) => {
  const p = req.pronto || { mode: "none", identity: null, key: "anon" };
  res.json({
    baseUrl: config.prontoBaseUrl,
    mode: p.mode,
    envMode: authMode(),                 // which .env mechanism exists (bearer-manual|login|cookie|none)
    authRequired: p.mode === "none",
    identity: p.identity,
    userKey: p.key,
    tokenGeneratorUrl: config.tokenGeneratorUrl || null,
    broker: !config.brokerDisabled,      // "Sign in with HavasPronto" available?
  });
});

/**
 * PKCE broker: start a "Sign in with HavasPronto" attempt. The browser opens
 * loginUrl (the Pronto site, SSO included) and then polls /broker/poll with pid.
 */
router.post("/broker/start", async (req, res) => {
  if (config.brokerDisabled) return res.status(404).json({ ok: false, error: "Broker sign-in is disabled" });
  // Suggested return page (ignored by the broker today; see session.js note).
  const returnUrl = `${req.protocol}://${req.get("host")}/auth/callback`;
  const r = await brokerStart(returnUrl);
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, error: r.error });
  res.json({ ok: true, pid: r.pid, loginUrl: r.loginUrl, pollMs: 3000 });
});

/** Poll the broker attempt. Pending until the user completes login on the site. */
router.post("/broker/poll", async (req, res) => {
  const r = await brokerPoll((req.body || {}).pid);
  if (r.ok && r.pending) return res.json({ ok: true, pending: true, retryAfter: r.retryAfter });
  if (r.ok && r.sid) {
    res.setHeader("Set-Cookie", [sidCookie(r.sid), envBypassCookie(false)]);
    return res.json({ ok: true, identity: r.identity });
  }
  res.status(r.status || 400).json({ ok: false, error: r.error });
});

/**
 * Per-user login. Body: { email, password } OR { token }.
 * email+password are exchanged with POST {base}/v2/api/auth/login for a bearer
 * token (the password is forwarded once, never stored); a pasted token is
 * verified via /v2/api/auth/me. Either way the session stores token+identity
 * and the browser gets an httpOnly pronto_sid cookie.
 */
router.post("/login", async (req, res) => {
  const { token, email, password } = req.body || {};
  const r = await loginUser({ token, email, password });
  if (!r.ok) return res.status(r.status || 401).json({ ok: false, error: r.error });
  res.setHeader("Set-Cookie", [sidCookie(r.sid), envBypassCookie(false)]);
  res.json({ ok: true, identity: r.identity });
});

/** Log out: destroy the user session. With .env fallback credentials configured,
 *  also set the env-bypass cookie so THIS browser gets the login screen instead
 *  of being silently auto-signed-in again. */
router.post("/logout", async (req, res) => {
  const s = await getSession(req);
  if (s) await destroySession(s.sid);
  res.setHeader("Set-Cookie", [sidCookie("", { destroy: true }), envBypassCookie(true)]);
  res.json({ ok: true });
});

/**
 * Live check: fire one tiny report as the current identity to prove the
 * credentials work against the reporting endpoint.
 */
router.get("/verify", async (req, res) => {
  const p = req.pronto || { mode: "none" };
  if (p.mode === "none") {
    return res.status(401).json({ ok: false, authRequired: true, error: "Not signed in" });
  }
  const spec = {
    dataSource: "timesheet_user_data", groupBy: "author_office_name", interval: "1MONTH",
    displayAs: "count", dateFrom: "2026-06-01", dateTo: "2026-06-30", limit: 5,
  };
  const t0 = Date.now();
  const report = await fetchReport(spec, { timeoutMs: 90000, auth: p.auth });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (!report.ok) {
    return res.status(report.status || 502).json({
      ok: false, stage: "report", mode: p.mode, user: p.identity, authUsed: report.authUsed,
      authRequired: report.authRequired, seconds, error: report.error,
    });
  }
  const intervals = report.data?.facets?.interval_report?.buckets?.length ?? 0;
  res.json({ ok: true, mode: p.mode, user: p.identity, authUsed: report.authUsed, seconds, reportStatus: report.status, qtime: report.qtime, intervalsReturned: intervals });
});

export default router;
