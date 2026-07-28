import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load .env from the project root explicitly, so it works no matter which
// directory the process is launched from.
const envPath = path.join(projectRoot, ".env");
const envResult = dotenv.config({ path: envPath });
if (envResult.error) {
  console.warn(`[config] No .env found at ${envPath} (${envResult.error.code || "error"}). Using process env / defaults.`);
}

export const config = {
  prontoBaseUrl: (process.env.PRONTO_BASE_URL || "https://havaspronto.com").replace(/\/+$/, ""),
  email: process.env.PRONTO_EMAIL?.trim() || "",
  password: process.env.PRONTO_PASSWORD || "",
  bearerToken: process.env.PRONTO_BEARER_TOKEN?.trim() || "",
  cookie: process.env.PRONTO_COOKIE?.trim() || "",
  port: Number(process.env.PORT) || 8787,
  // Where the .env single-identity fallback applies:
  //   "local" (default) — loopback requests only (your own browser on the dev box).
  //     Remote visitors (shared links, other computers) are NOT auto-signed-in.
  //   "all" — legacy behaviour: every cookie-less request runs as the env identity.
  //   "off" — never.
  envFallback: (process.env.PRONTO_ENV_FALLBACK || "local").trim().toLowerCase(),
  // Optional: page on havaspronto.com where users can generate an API token.
  // Shown as a "Get a token" link on the login screen when set.
  tokenGeneratorUrl: process.env.TOKEN_GENERATOR_URL?.trim() || "",
  // PKCE broker ("Sign in with HavasPronto") — endpoints hosted by the Pronto site.
  // Defaults derive from PRONTO_BASE_URL; override if the site moves them.
  pkceStartUrl: process.env.PRONTO_PKCE_START_URL?.trim() || "",
  pkceExchangeUrl: process.env.PRONTO_PKCE_EXCHANGE_URL?.trim() || "",
  brokerLoginUrl: process.env.PRONTO_BROKER_LOGIN_URL?.trim() || "",   // template; {txn_id} appended
  brokerDisabled: (process.env.PRONTO_BROKER ?? "").trim().toLowerCase() === "off",
  cacheEnabled: (process.env.CACHE_ENABLED ?? "true") !== "false",
  // On Vercel the deployment bundle is read-only; only /tmp is writable. Persistent
  // state lives in Redis (see kv.js); this path only backs the best-effort local
  // fallbacks (e.g. the env-mode token cache), so point it at /tmp there so those
  // writes don't throw against the read-only filesystem.
  cacheDir: process.env.CACHE_DIR
    ? path.resolve(projectRoot, process.env.CACHE_DIR)
    : (process.env.VERCEL ? "/tmp/.cache" : path.resolve(projectRoot, ".cache")),
};

// Auth lifecycle (login / token / headers) lives in session.js.
