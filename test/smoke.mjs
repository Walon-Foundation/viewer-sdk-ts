// A plain script, not a node:test suite, for runtimes whose test runner can't run the
// suite (Bun 1.1 has no node:test). It exits non-zero on the first thing that's wrong.
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { createLogger } from "#sdk";

function fail(...why) {
  console.error("smoke test failed:", ...why);
  process.exit(1);
}

// The core: console output, child attributes, exception fields.
const lines = [];
const local = createLogger({
  console: "json",
  service: "smoke",
  write: (l) => lines.push(l),
});
local.child({ k: "v" }).error("smoke", { err: new Error("boom"), n: 1 });
const r = JSON.parse(lines[0]);
if (
  r.msg !== "smoke" ||
  r.k !== "v" ||
  r.n !== 1 ||
  r["exception.type"] !== "Error" ||
  r.service !== "smoke"
)
  fail(lines);

// The transport: gzip, fetch and OTLP/JSON to a local server.
const got = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    got.push(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()));
    res.writeHead(200);
    res.end();
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const log = createLogger({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  apiKey: "k",
  console: false,
});
log.info("over the wire", { n: 2 });
const res = await log.shutdown();
server.close();
const rec = got[0]?.resourceLogs[0].scopeLogs[0].logRecords[0];
if (
  res.unsent !== 0 ||
  rec?.body.stringValue !== "over the wire" ||
  log.stats().sent !== 1
)
  fail(res, JSON.stringify(got));
console.log("smoke ok");
