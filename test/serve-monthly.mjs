// Boots the real server against the mock upstream in this folder, with its own cache dir.
//   node test/serve-monthly.mjs <port> <all|off>
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WORK = process.env.TEST_WORK_DIR || path.join(HERE, ".work");

process.env.PRONTO_BASE_URL = "http://localhost:8910";
process.env.PRONTO_BEARER_TOKEN = "test-token";
process.env.PRONTO_ENV_FALLBACK = process.argv[3] || "all";
process.env.PRONTO_BROKER = "off";
process.env.CACHE_DIR = path.join(WORK, ".cache");
process.env.PORT = process.argv[2] || "8911";
process.env.CACHE_ENABLED = "true";
process.env.VERCEL = "1";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.REDIS_URL;

const { default: app } = await import(path.join(REPO, "server/index.js"));
app.listen(Number(process.env.PORT), () =>
  console.log(`[server-test:${process.env.PRONTO_ENV_FALLBACK}] :${process.env.PORT}`));
