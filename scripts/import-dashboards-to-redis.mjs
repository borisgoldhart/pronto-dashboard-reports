// One-time importer: push the dashboards you've saved locally (the JSON docs in
// data/dashboards/) into Redis, so they show up on the deployed Vercel app.
//
// Usage (from the pronto-dashboard folder, with the Upstash env vars loaded —
// e.g. after `vercel env pull .env`):
//     node scripts/import-dashboards-to-redis.mjs
//
// It is idempotent: re-running overwrites the same GUID docs. Backups (*.bak.json)
// and the .migrated flag are skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../server/config.js";
import { kvEnabled, jset, hsetJSON } from "../server/kv.js";

if (!kvEnabled) {
  console.error("No Redis configured. Set KV_REST_API_URL + KV_REST_API_TOKEN (or REDIS_URL) first.");
  process.exit(1);
}

const DIR = path.resolve(config.cacheDir, "..", "data", "dashboards");
if (!fs.existsSync(DIR)) {
  console.log(`No local dashboards dir at ${DIR} — nothing to import.`);
  process.exit(0);
}

const isGuidFile = (f) => /^[0-9a-f-]{36}\.json$/i.test(f);
const indexEntry = (d) => ({
  guid: d.guid, title: d.title || "Untitled",
  updatedAt: d.updatedAt || d.createdAt || null,
  createdBy: d.createdBy || null,
  widgetCount: Array.isArray(d.widgets) ? d.widgets.length : 0,
});

let n = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!isGuidFile(f)) continue;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    if (!doc?.guid) continue;
    await jset(`dash:${doc.guid}`, doc);
    await hsetJSON("dash:index", doc.guid, indexEntry(doc));
    console.log(`  imported ${doc.guid}  "${doc.title || "Untitled"}" (${indexEntry(doc).widgetCount} widgets)`);
    n++;
  } catch (err) {
    console.warn(`  skipped ${f}: ${err.message}`);
  }
}
console.log(`\nDone — imported ${n} dashboard(s) into Redis.`);
setTimeout(() => process.exit(0), 100);
