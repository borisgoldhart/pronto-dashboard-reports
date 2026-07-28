// Integration test for the storage refactor. Runs the same assertions against
// whichever backend the env selects (real Redis when REDIS_URL is set, else the
// filesystem fallback). Invoked twice by run-tests.sh.
import assert from "node:assert";
import * as store from "../server/store.js";
import * as cache from "../server/cache.js";
import { createSession, getSession, updateSession, destroySession } from "../server/users.js";
import { kvEnabled, kvBackend } from "../server/kv.js";

const mode = kvEnabled ? `REDIS (${kvBackend})` : "FILESYSTEM";
let pass = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };

console.log(`\n=== storage tests — backend: ${mode} ===`);

// ---- dashboard store ----
const alice = { id: "alice1", name: "Alice", email: "a@x.com" };
const bob = { id: "bob2", name: "Bob", email: "b@x.com" };

const d1 = await store.createDashboard({ title: "Q3 Board", identity: alice });
assert(/^[0-9a-f-]{36}$/i.test(d1.guid), "guid shape");
ok("createDashboard returns a doc with a GUID");

assert(await store.dashboardExists(d1.guid), "exists true");
assert(!(await store.dashboardExists("not-a-guid")), "exists false for junk");
assert(!(await store.dashboardExists("00000000-0000-0000-0000-000000000000")), "exists false for absent guid");
ok("dashboardExists works");

const got = await store.getDashboard(d1.guid);
assert.equal(got.title, "Q3 Board");
assert.equal(got.createdBy.id, "alice1");
ok("getDashboard round-trips");

const d2 = await store.createDashboard({ title: "Bob board", identity: bob });
const aliceList = await store.listDashboards({ ownerId: "alice1" });
assert.equal(aliceList.length, 1, "alice sees only her dashboard");
assert.equal(aliceList[0].guid, d1.guid);
const allList = await store.listDashboards({ all: true });
assert(allList.length >= 2, "all mode sees both");
ok("listDashboards filters by owner + all-mode");

// save + widget persistence + backup
const saved = await store.saveDashboard(d1.guid, { title: "Q3 Board v2", widgets: [{ id: "w1", type: "bar" }] }, alice);
assert.equal(saved.title, "Q3 Board v2");
assert.equal(saved.widgets.length, 1);
const reread = await store.getDashboard(d1.guid);
assert.equal(reread.widgets[0].id, "w1", "widgets persisted");
assert(reread.updatedAt >= reread.createdAt, "updatedAt advanced");
ok("saveDashboard persists title + widgets");

// canEdit rules
assert(store.canEdit(reread, { mode: "session", identity: alice }), "owner can edit");
assert(!store.canEdit(reread, { mode: "session", identity: bob }), "non-owner cannot edit");
assert(store.canEdit(reread, { mode: "env" }), "env can edit anything");
ok("canEdit enforces creator-only");

// touchRefreshed
const before = reread.lastRefreshedAt;
const touched = await store.touchRefreshed(d1.guid);
assert(touched.lastRefreshedAt && touched.lastRefreshedAt !== before, "refresh stamp set");
ok("touchRefreshed stamps lastRefreshedAt");

// delete
assert(await store.deleteDashboard(d2.guid), "delete returns true");
assert(!(await store.dashboardExists(d2.guid)), "gone after delete");
assert.equal(await store.getDashboard(d2.guid), null, "getDashboard null after delete");
const aliceAfter = await store.listDashboards({ ownerId: "alice1" });
assert.equal(aliceAfter.length, 1, "index updated after delete");
ok("deleteDashboard removes doc + index entry");

// ---- report cache ----
const spec = { dataSource: "job", groupBy: "office", dateFrom: "2026-01-01", dateTo: "2026-03-31", nonce: Math.floor(pass * 7919) };
assert.equal(await cache.get(spec), null, "cache miss before set");
await cache.set(spec, { rows: [1, 2, 3] });
const cached = await cache.get(spec);
assert.deepEqual(cached, { rows: [1, 2, 3] }, "cache round-trips");
ok("report cache set/get round-trips");
const st = await cache.stats();
assert(st.entries >= 1, "stats counts entries");
ok(`cache stats report entries (${st.entries})`);

// ---- sessions ----
const sid = await createSession({ token: "tok-abc", cookie: "c=1", identity: alice, expiresIn: 3600 });
assert(typeof sid === "string" && sid.length > 10, "sid returned");
const fakeReq = (theSid) => ({ headers: { cookie: `pronto_sid=${theSid}` }, socket: { remoteAddress: "::1" } });
const sess = await getSession(fakeReq(sid));
assert.equal(sess.token, "tok-abc", "session token retrievable");
assert.equal(sess.identity.id, "alice1", "session identity retrievable");
ok("createSession + getSession round-trip (cross-'instance' read)");

assert.equal(await getSession(fakeReq("bogus-sid")), null, "unknown sid -> null");
assert.equal(await getSession({ headers: {}, socket: {} }), null, "no cookie -> null");
ok("getSession rejects unknown / missing sid");

await updateSession(sid, { cookie: "c=2", token: "tok-xyz" });
const sess2 = await getSession(fakeReq(sid));
assert.equal(sess2.token, "tok-xyz", "token updated");
assert.equal(sess2.cookie, "c=2", "cookie updated");
ok("updateSession persists a patch");

await destroySession(sid);
assert.equal(await getSession(fakeReq(sid)), null, "session gone after logout");
ok("destroySession clears the session");

console.log(`\n=== ${mode}: ${pass} assertions passed ===\n`);

// flush any lingering redis connection so the process exits
setTimeout(() => process.exit(0), 100);
