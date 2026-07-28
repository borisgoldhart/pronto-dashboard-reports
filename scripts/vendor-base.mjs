// Vendor the shared pronto-base package into the project root so it ships with
// a serverless deploy (the canonical copy is a sibling folder, ../pronto-base,
// which lives outside this project and so isn't uploaded to Vercel).
//
// Run before deploying:  npm run vendor:base
// Safe to re-run — it mirrors the sibling into ./pronto-base.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(root, "..", "pronto-base");
const dest = path.resolve(root, "pronto-base");

if (!fs.existsSync(src)) {
  console.error(`[vendor-base] source not found: ${src}`);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[vendor-base] copied ${src} -> ${dest}`);
