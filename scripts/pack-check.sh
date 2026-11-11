#!/usr/bin/env bash
# T4 (plan7): pack the package and use the tarball from scratch Node and Bun projects,
# through both import and require, sending one log each to a local OTLP endpoint.
set -euo pipefail
cd "$(dirname "$0")/.."
bun --bun tsdown >/dev/null
rm -f ./*.tgz
bun pm pack --quiet >/dev/null
tgz="$(pwd)/$(ls ./*.tgz | head -1)"
work="$(mktemp -d)"
trap 'rm -rf "$work"; rm -f "$tgz"' EXIT

# A one-file OTLP receiver that counts records and prints the count when told to stop.
cat >"$work/receiver.mjs" <<'JS'
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
let n = 0;
const s = createServer((req, res) => {
  if (req.url === "/count") return res.end(String(n));
  const c = [];
  req.on("data", (d) => c.push(d));
  req.on("end", () => {
    const body = JSON.parse(gunzipSync(Buffer.concat(c)).toString());
    n += body.resourceLogs[0].scopeLogs[0].logRecords.length;
    res.end();
  });
});
s.listen(0, "127.0.0.1", () => console.log(s.address().port));
JS
node "$work/receiver.mjs" >"$work/port" &
receiver=$!
trap 'kill $receiver 2>/dev/null; rm -rf "$work"; rm -f "$tgz"' EXIT
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
endpoint="http://127.0.0.1:$(cat "$work/port")"

mkdir -p "$work/app"
cd "$work/app"
echo '{"name":"scratch","private":true}' >package.json
npm install --silent --no-audit --no-fund "$tgz" >/dev/null

cat >esm.mjs <<'JS'
import { createLogger, SDK_VERSION } from "@walon-foundation/viewer-sdk-ts";
const log = createLogger({ endpoint: process.env.EP, apiKey: "k", console: false });
log.info("from esm", { runtime: process.versions.bun ? "bun" : "node" });
const r = await log.shutdown();
if (r.unsent !== 0 || log.stats().sent !== 1) process.exit(1);
console.log(`esm ok ${SDK_VERSION}`);
JS
cat >cjs.cjs <<'JS'
const { createLogger } = require("@walon-foundation/viewer-sdk-ts");
const { viewerMiddleware } = require("@walon-foundation/viewer-sdk-ts/express");
if (typeof viewerMiddleware !== "function") process.exit(1);
const log = createLogger({ endpoint: process.env.EP, apiKey: "k", console: false });
log.info("from cjs");
log.shutdown().then((r) => {
  if (r.unsent !== 0 || log.stats().sent !== 1) process.exit(1);
  console.log("cjs ok");
});
JS
cat >types.ts <<'JS'
import { createLogger, type Logger } from "@walon-foundation/viewer-sdk-ts";
const log: Logger = createLogger({ service: "typed" });
log.info("typed", { n: 1 });
JS

for rt in node bun; do
  EP="$endpoint" $rt esm.mjs
  EP="$endpoint" $rt cjs.cjs
done
received=$(curl -s "$endpoint/count")
echo "receiver got $received records"
[ "$received" = 4 ]
npx --yes -p typescript@5.9.3 tsc --noEmit --strict --module nodenext --moduleResolution nodenext --skipLibCheck types.ts
echo "types ok"
echo "pack check passed: $(basename "$tgz")"
