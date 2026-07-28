import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { fetchReport, normalize } from "./pronto.js";
import { kvEnabled, jget, jset } from "./kv.js";

/**
 * The Pronto API has no dedicated offices endpoint, so we derive the office list from
 * the reporting facet — the union of client_office_name (job/project office) and
 * author_office_name (user office) over a wide window. Offices change rarely, so the
 * result is cached for 7 days (Redis when configured, else on disk).
 */

const FILE = path.join(config.cacheDir, ".offices.json");
const KV_KEY = "offices:list";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_SEC = Math.floor(TTL_MS / 1000);
const WINDOW = { from: "2024-01-01", to: new Date().toISOString().slice(0, 10) };

let mem = null;   // per-instance fast path

async function readCache() {
  try {
    if (mem && Date.now() - (mem.fetchedAt || 0) < TTL_MS) return mem;
    if (kvEnabled) {
      const raw = await jget(KV_KEY);
      if (raw?.offices?.length) { mem = raw; return raw; }
      return null;
    }
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (raw?.offices?.length && Date.now() - (raw.fetchedAt || 0) < TTL_MS) { mem = raw; return raw; }
    }
  } catch {}
  return null;
}

async function writeCache(offices) {
  mem = { offices, fetchedAt: Date.now() };
  try {
    if (kvEnabled) { await jset(KV_KEY, mem, { ttlSec: TTL_SEC }); return; }
    if (!fs.existsSync(config.cacheDir)) fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem));
  } catch {}
}

async function facetOffices(dataSource, field, auth) {
  const r = await fetchReport({
    dataSource, groupBy: field, interval: "1YEAR", displayAs: "count",
    dateFrom: WINDOW.from, dateTo: WINDOW.to, limit: 1000,
  }, { timeoutMs: 90000, auth });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, names: normalize(r.data).series };
}

/** Returns { ok, offices:[name...] } — cached (the office list is org-wide, so the
 *  7-day cache is shared; the fetch itself runs as the requesting user). */
export async function listOffices({ refresh = false, auth = null } = {}) {
  if (!refresh) { const c = await readCache(); if (c) return { ok: true, offices: c.offices, cached: true }; }

  const [client, author] = await Promise.all([
    facetOffices("job", "client_office_name", auth),
    facetOffices("timesheet_user_data", "author_office_name", auth),
  ]);
  if (!client.ok && !author.ok) return { ok: false, error: client.error || author.error, status: client.status || author.status };

  const set = new Set([...(client.names || []), ...(author.names || [])].filter(Boolean));
  const offices = [...set].sort((a, b) => a.localeCompare(b));
  if (offices.length) await writeCache(offices);
  return { ok: true, offices };
}
