// A plain script, not a node:test suite, for runtimes whose test runner can't run the
// suite (Bun 1.1 has no node:test). It exits non-zero on the first thing that's wrong.
import { createLogger } from "#sdk";

const lines = [];
const log = createLogger({
  console: "json",
  service: "smoke",
  write: (l) => lines.push(l),
});
log.child({ k: "v" }).error("smoke", { err: new Error("boom"), n: 1 });
const r = JSON.parse(lines[0]);
const ok =
  r.msg === "smoke" &&
  r.k === "v" &&
  r.n === 1 &&
  r["exception.type"] === "Error" &&
  r.service === "smoke";
if (!ok) {
  console.error("smoke test failed:", lines);
  process.exit(1);
}
console.log("smoke ok");
