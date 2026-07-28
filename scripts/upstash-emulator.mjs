// Minimal Upstash-REST-protocol emulator, backed by a real local Redis via
// ioredis. Purpose: exercise the @upstash/redis (REST) client path of kv.js
// end-to-end without a cloud account. Implements the single-command endpoint
// (POST / with a JSON array body) which is what @upstash/redis uses for
// non-pipelined commands. NOT for production — test harness only.
import http from "node:http";
import IORedis from "ioredis";

const redis = new IORedis("redis://127.0.0.1:6379");
const PORT = 8079;

// Faithfully mimic Upstash REST replies. ioredis' .call('hgetall') folds the
// reply into an object, but real Upstash REST returns the raw flat array
// [field, value, ...] which the @upstash/redis client then folds itself — so
// flatten it back for the emulator to behave like the real service.
async function run(cmd) {
  const reply = await redis.call(...cmd.map(String));
  if (String(cmd[0]).toLowerCase() === "hgetall" && reply && !Array.isArray(reply) && typeof reply === "object") {
    return Object.entries(reply).flat();
  }
  return reply;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "[]");
      res.setHeader("Content-Type", "application/json");
      // Pipeline shape: array of command-arrays -> array of {result}|{error}.
      if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
        const out = [];
        for (const cmd of parsed) {
          try { out.push({ result: await run(cmd) }); }
          catch (e) { out.push({ error: String(e.message || e) }); }
        }
        res.end(JSON.stringify(out));
        return;
      }
      // Single command: ["set","k","v","ex","60"] -> { result }
      const reply = await run(parsed);
      res.end(JSON.stringify({ result: reply }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
});

server.listen(PORT, () => console.log(`[emulator] Upstash-REST shim on :${PORT}`));
