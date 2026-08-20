import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { fetchReport } from "./pronto.js";
import { kvEnabled, jget, jset } from "./kv.js";

/**
 * Pickable lists for the brand dimensions: Brand Category (Master Client) and Brand.
 *
 * WHY ids AND names, when the picker only ever shows names
 * -------------------------------------------------------
 * The reporting API matches a *_name filter as words, not as a value. Verified live:
 * filtering brandcat_name on "Havas Life" comes back with 37 categories, among them
 * "Sun Life" and "SK Life Science", because "Life" is a word in all of them. A picker
 * that filtered by name would therefore quietly report on the wrong brands.
 *
 * The numeric id fields (brandcat_id, brand_id) match exactly, so the list pairs each
 * name with its id: the person picks a name, the query filters on the id.
 *
 * The pairs come from the index itself rather than from Pronto's own brand API, so the
 * ids are guaranteed to be the ones this index actually holds. One facet query per
 * dimension, grouped by id and sub-grouped by name: ~6s for ~3,900 brands, so it is
 * cached for 7 days exactly like the office list.
 *
 * Names are not unique the other way round, though — live, "DUPIXENT" is two separate
 * brand ids — so each brand also carries the category it mostly sits under, which is what
 * the picker shows beside the name to tell two same-named brands apart.
 */

const DIMENSIONS = {
  brandcat: { idField: "brandcat_id", nameField: "brandcat_name", label: "Brand Category" },
  // Brand names are NOT unique: live, "DUPIXENT" is two different brand ids (22,736 jobs
  // and 1,126). Two identical rows in a picker is a coin toss, so each brand also carries
  // the category it sits under, fetched the same way.
  brand: { idField: "brand_id", nameField: "brand_name", label: "Brand", contextField: "brandcat_name" },
};

export const isDimension = (key) => Object.hasOwn(DIMENSIONS, key);
export const dimensionMeta = (key) => DIMENSIONS[key] || null;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_SEC = Math.floor(TTL_MS / 1000);
// Deliberately wide: a brand that hasn't been touched since 2023 should still be
// pickable, because a duplicated dashboard may be pointed at an older window.
const WINDOW = { from: "2022-01-01", to: () => new Date().toISOString().slice(0, 10) };
const FACET_LIMIT = 20000;

// Bumped whenever the stored item shape changes, so a deploy can't be left serving
// last week's cache in an older shape (v2 added each brand's category).
const CACHE_VERSION = 2;
const fileFor = (key) => path.join(config.cacheDir, `.dim-${key}.v${CACHE_VERSION}.json`);
const kvKeyFor = (key) => `dimension:v${CACHE_VERSION}:${key}`;

const mem = new Map();   // key -> { items, fetchedAt }

async function readCache(key) {
  try {
    const m = mem.get(key);
    if (m && Date.now() - (m.fetchedAt || 0) < TTL_MS) return m;
    if (kvEnabled) {
      const raw = await jget(kvKeyFor(key));
      if (raw?.items?.length) { mem.set(key, raw); return raw; }
      return null;
    }
    const f = fileFor(key);
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      if (raw?.items?.length && Date.now() - (raw.fetchedAt || 0) < TTL_MS) { mem.set(key, raw); return raw; }
    }
  } catch {}
  return null;
}

async function writeCache(key, items) {
  const payload = { items, fetchedAt: Date.now() };
  mem.set(key, payload);
  try {
    if (kvEnabled) { await jset(kvKeyFor(key), payload, { ttlSec: TTL_SEC }); return; }
    if (!fs.existsSync(config.cacheDir)) fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(fileFor(key), JSON.stringify(payload));
  } catch {}
}

/** One facet query: ids as the group, some name field as the sub-group, paired per bucket. */
async function facetBy(dim, subField, auth) {
  return fetchReport({
    dataSource: "job",
    groupBy: dim.idField,
    subGroup: subField,
    interval: "0",
    displayAs: "count",
    dateFrom: WINDOW.from,
    dateTo: WINDOW.to(),
    limit: FACET_LIMIT,
  }, { timeoutMs: 120000, auth });
}

/** The busiest sub-group value in a bucket — an id filed under two spellings should show
 *  the one it mostly carries rather than being dropped or picked at random. */
const topSub = (b) => (b.facet?.buckets || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0))[0]?.val;

async function fetchPairs(dim, auth) {
  const r = await facetBy(dim, dim.nameField, auth);
  if (!r.ok) return { ok: false, error: r.error, status: r.status };

  // What each id sits under, so two brands of the same name can be told apart.
  let context = null;
  if (dim.contextField) {
    const c = await facetBy(dim, dim.contextField, auth);
    if (c.ok) {
      context = new Map();
      for (const b of c.data?.facets?.group?.buckets || []) {
        const v = topSub(b);
        if (b.val != null && v) context.set(String(b.val), String(v));
      }
    }
  }

  const buckets = r.data?.facets?.group?.buckets || [];
  const items = [];
  for (const b of buckets) {
    const id = b.val;
    const name = topSub(b);
    if (id == null || !name) continue;
    items.push({
      id: String(id),
      name: String(name),
      count: Number(b.count) || 0,
      ...(context?.get(String(id)) ? { context: context.get(String(id)) } : {}),
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, items };
}

/**
 * Returns { ok, items:[{id,name,count}] } for a dimension key ("brandcat" | "brand").
 * Cached org-wide for 7 days; the fetch itself runs as the requesting user.
 */
export async function listDimension(key, { refresh = false, auth = null } = {}) {
  const dim = DIMENSIONS[key];
  if (!dim) return { ok: false, error: `Unknown dimension: ${key}`, status: 400 };

  if (!refresh) { const c = await readCache(key); if (c) return { ok: true, items: c.items, cached: true }; }

  const r = await fetchPairs(dim, auth);
  if (!r.ok) return r;
  if (r.items.length) await writeCache(key, r.items);
  return { ok: true, items: r.items };
}

/**
 * Search a dimension by name. Names starting with the term come first — typing "hav"
 * should offer "Havas Health" before "Big Havas Thing" — then busiest first, so the
 * brands someone is likely to mean are at the top rather than whatever sorts first
 * alphabetically.
 */
export async function searchDimension(key, q, { limit = 40, auth = null, refresh = false } = {}) {
  const r = await listDimension(key, { auth, refresh });
  if (!r.ok) return r;
  const term = String(q || "").trim().toLowerCase();
  let items = r.items;
  if (term) {
    items = items
      .filter((it) => it.name.toLowerCase().includes(term))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(term) ? 0 : 1;
        const bs = b.name.toLowerCase().startsWith(term) ? 0 : 1;
        if (as !== bs) return as - bs;
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  } else {
    items = items.slice().sort((a, b) => b.count - a.count);   // no term: busiest first
  }
  return { ok: true, total: items.length, items: items.slice(0, limit) };
}
