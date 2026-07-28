import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { authMode } from "./session.js";
import { attachUser } from "./users.js";
import authRoutes from "./routes/auth.js";
import reportRoutes from "./routes/report.js";
import dashboardRoutes from "./routes/dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/api", attachUser);          // per-user session -> req.pronto (env-credential fallback)
app.use("/api/auth", authRoutes);
app.use("/api/report", reportRoutes);
app.use("/api", dashboardRoutes);     // /api/dashboards + /api/dashboard/:guid (GUID report-builder model)

app.get("/api/health", (_req, res) => res.json({ ok: true, authMode: authMode() }));

// Return page for the broker sign-in popup. The Pronto broker currently ignores
// our suggested redirect_uri, but if/when it honours it, the popup lands here and
// closes itself. Also a friendly endpoint if a user opens it directly.
app.get("/auth/callback", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:15px/1.5 Lato,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:96vh;color:#18181a">
<div style="text-align:center"><h2 style="margin:0 0 6px">Signed in ✓</h2>
<p style="color:#666">You can close this tab and return to the Reporting Dashboard.</p></div>
<script>setTimeout(function(){ window.close(); }, 800);</script></body>`);
});

// SPA route: the dashboards table (client-rendered from the same index.html).
app.get("/dashboards", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// Serve the shared "pronto-base" package (nav + page template) at /base.
// Prototype hosting only — in production this moves to a static/CDN host
// (see docs/PROPOSAL-pronto-base.md). /base/v1/ is the release channel.
//
// Locally the canonical copy is the sibling folder (../../pronto-base), kept as
// the single source of truth. On a serverless deploy that sibling is outside
// the project root and isn't uploaded, so we fall back to a copy vendored into
// the project root (./pronto-base — populated by scripts/vendor-base.mjs and
// bundled via vercel.json includeFiles).
const siblingBase = path.resolve(__dirname, "..", "..", "pronto-base");
const vendoredBase = path.resolve(__dirname, "..", "pronto-base");
const baseDir = fs.existsSync(siblingBase) ? siblingBase : vendoredBase;
app.use("/base", express.static(baseDir, {
  etag: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"), // dev; prod = long max-age + versioned channel
}));

// Serve the SPA (Phase 2/3 frontend lives in /public).
// no-cache so the browser always revalidates — avoids stale index.html/app.js mismatches.
app.use(express.static(publicDir, {
  etag: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

// Exported for serverless hosts (Vercel's @vercel/node wraps the app);
// when run directly (npm start / a VM) we listen ourselves.
export default app;

if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`\n  Pronto Dashboard server`);
    console.log(`  ---------------------------------------`);
    console.log(`  Local:      http://localhost:${config.port}`);
    console.log(`  Base pkg:   http://localhost:${config.port}/base/demo/  (shared nav/template demo)`);
    console.log(`  API base:   ${config.prontoBaseUrl}`);
    console.log(`  Auth mode:  ${authMode()}${authMode() === "none" ? "  (multi-user login mode)" : ""}`);
    console.log(`  Cache:      ${config.cacheEnabled ? config.cacheDir : "disabled"}\n`);
  });
}
