import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { encodeRecord, rejectedIn, retryAfterMs, rfc3339 } from "#internal";
import { createLogger } from "#sdk";
import { stderrLines } from "./helpers.mjs";

/** A fake Viewer: records each request and answers with the next queued response. */
async function fakeServer(answers = []) {
  const reqs = [];
  const waiters = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = gunzipSync(Buffer.concat(chunks)).toString();
      reqs.push({ headers: req.headers, body: JSON.parse(raw) });
      const a = answers.shift() ?? { status: 200 };
      if (a.hang) return; // never answer
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body ?? "");
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const records = () =>
    reqs.flatMap((q) => q.body.resourceLogs[0].scopeLogs[0].logRecords);
  return { url, reqs, records, server };
}

function remoteLogger(url, opts = {}) {
  const log = createLogger({
    endpoint: url,
    apiKey: "vk_test",
    service: "billing",
    console: false,
    flushIntervalMs: 3_600_000,
    ...opts,
  });
  const waits = [];
  const t = log.core.transport;
  t.sleep = async (ms) => {
    waits.push(ms);
  };
  t.jitter = () => 0.5; // no jitter: 0.5 s, 1 s, 2 s, 4 s exactly
  return { log, waits };
}

const attr = (rec, key) => rec.attributes.find((a) => a.key === key)?.value;

describe("encoding", () => {
  it("matches the Go SDK's golden record", () => {
    const record = {
      timeUnixNano: "1794394721207000001",
      level: "error",
      message: "payment failed: card declined",
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      attributes: {
        request_id: "req_A",
        "http.status_code": 500,
        big: 18446744073709551615n,
        ratio: 0.25,
        nan: Number.NaN,
        retry: false,
        took_ms: 1500,
        at: new Date("2026-11-11T10:00:00Z"),
        err: new Error("card declined"),
        raw: new Uint8Array([104, 105]),
        tags: ["a", 2, true],
        meta: { z: 1, a: "x" },
        "http.route": "POST /invoices",
        nothing: null,
      },
    };
    const golden = JSON.parse(
      readFileSync(
        new URL("./testdata/record.golden.json", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(
      JSON.parse(encodeRecord(record, "1794394722000000000")),
      golden,
    );
  });

  it("writes times like Go's RFC3339Nano", () => {
    assert.equal(
      rfc3339(new Date("2026-11-11T10:00:00.000Z")),
      "2026-11-11T10:00:00Z",
    );
    assert.equal(
      rfc3339(new Date("2026-11-11T10:00:00.120Z")),
      "2026-11-11T10:00:00.12Z",
    );
  });
});

describe("sending", () => {
  it("posts gzipped OTLP/JSON with the key, by batch size", async () => {
    const s = await fakeServer();
    const { log } = remoteLogger(s.url, { batchSize: 2, env: "prod" });
    log.child({ user: "u1" }).info("one", { n: 1 });
    log.error("two", { ok: true, ratio: 0.5, tags: ["a"] });
    await log.flush();
    assert.equal(s.reqs.length, 1);
    const { headers, body } = s.reqs[0];
    assert.equal(headers.authorization, "Bearer vk_test");
    assert.equal(headers["content-encoding"], "gzip");
    assert.equal(headers["content-type"], "application/json");
    const rl = body.resourceLogs[0];
    const res = Object.fromEntries(
      rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    assert.equal(res["service.name"], "billing");
    assert.equal(res["deployment.environment.name"], "prod");
    assert.equal(res["telemetry.sdk.language"], "nodejs");
    assert.equal(rl.scopeLogs[0].scope.name, "viewer-sdk-ts");
    const [one, two] = s.records();
    assert.equal(one.body.stringValue, "one");
    assert.deepEqual(attr(one, "user"), { stringValue: "u1" });
    assert.equal(two.severityNumber, 17);
    assert.deepEqual(attr(two, "ratio"), { doubleValue: 0.5 });
    await log.shutdown();
  });

  it("sends on the interval too", async () => {
    const s = await fakeServer();
    const { log } = remoteLogger(s.url, { flushIntervalMs: 30 });
    log.info("alone");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.records().length, 1);
    await log.shutdown();
  });

  it("retries 5xx and 429, honouring Retry-After", async () => {
    const s = await fakeServer([
      { status: 503 },
      { status: 429, headers: { "retry-after": "7" } },
      { status: 502 },
    ]);
    const { log, waits } = remoteLogger(s.url);
    log.info("persistent");
    await log.flush();
    assert.equal(s.reqs.length, 4);
    assert.deepEqual(waits, [500, 7000, 2000]);
    assert.equal(log.stats().sent, 1);
    await log.shutdown();
  });

  it("gives up after five tries, and caps Retry-After at 30 s", async () => {
    const s = await fakeServer([
      { status: 429, headers: { "retry-after": "3600" } },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    const { log, waits } = remoteLogger(s.url);
    log.info("doomed");
    await log.flush();
    assert.equal(s.reqs.length, 5);
    assert.deepEqual(waits, [30_000, 1000, 2000, 4000]);
    assert.equal(log.stats().failed, 1);
    await log.shutdown();
  });

  it("does not retry refusals, and says a bad key once", async () => {
    const s = await fakeServer([
      { status: 400 },
      { status: 401 },
      { status: 401 },
    ]);
    const { log, waits } = remoteLogger(s.url, { batchSize: 1 });
    const said = await stderrLines(async () => {
      for (const m of ["a", "b", "c"]) {
        log.info(m);
        await log.flush();
      }
    });
    assert.equal(s.reqs.length, 3);
    assert.deepEqual(waits, []);
    assert.equal(log.stats().rejected, 3);
    assert.equal(
      said.filter((l) => l.includes("refused the API key")).length,
      1,
    );
    await log.shutdown();
  });

  it("counts partial success, written as a string or a number", async () => {
    for (const body of [
      '{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"too big"}}',
      '{"partialSuccess":{"rejectedLogRecords":2}}',
    ]) {
      const s = await fakeServer([{ status: 200, body }]);
      const { log } = remoteLogger(s.url);
      for (let i = 0; i < 5; i++) log.info("r");
      await log.flush();
      assert.equal(log.stats().sent, 3);
      assert.equal(log.stats().rejected, 2);
      await log.shutdown();
    }
  });
});

describe("losing records, and saying so", () => {
  it("drops the oldest when the queue is full", async () => {
    const seen = [];
    const log = createLogger({
      console: false,
      queueSize: 3,
      batchSize: 10,
      flushIntervalMs: 3_600_000,
      exporter: {
        export: async (rs) => seen.push(...rs.map((r) => r.message)),
      },
    });
    for (const m of ["1", "2", "3", "4", "5"]) log.info(m);
    assert.equal(log.stats().queueFull, 2);
    await log.shutdown();
    assert.deepEqual(seen.slice(0, 3), ["3", "4", "5"]);
    assert.match(seen[3], /^viewer-sdk: dropped 2 records since /); // the drop rides along
  });

  it("reports drops once, on the next batch that gets through", async () => {
    const s = await fakeServer([{ status: 400 }]);
    const { log } = remoteLogger(s.url);
    log.info("refused");
    await log.flush();
    log.info("next");
    await log.flush();
    log.info("after");
    await log.flush();
    const bodies = s.records().map((r) => r.body.stringValue);
    assert.equal(bodies.length, 4);
    assert.equal(bodies[1], "next");
    assert.match(
      bodies[2],
      /^viewer-sdk: dropped 1 records since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
    );
    assert.equal(bodies[3], "after");
    const report = s.records()[2];
    assert.equal(report.severityNumber, 13);
    assert.deepEqual(attr(report, "viewer.dropped.rejected"), {
      intValue: "1",
    });
    assert.equal(log.stats().sent, 2); // the report isn't a user record
    await log.shutdown();
  });

  it("an exporter that fails is counted, not retried", async () => {
    let calls = 0;
    const log = createLogger({
      console: false,
      exporter: {
        export: async () => {
          calls++;
          throw new Error("database down");
        },
      },
    });
    log.info("lost");
    await log.shutdown();
    assert.equal(calls, 1);
    assert.equal(log.stats().failed, 1);
  });
});

describe("flush and shutdown", () => {
  it("shutdown sends everything, then logs reach the console only", async () => {
    const s = await fakeServer();
    const { log } = remoteLogger(s.url, { batchSize: 1000 });
    for (let i = 0; i < 1200; i++) log.info("r");
    const first = log.shutdown();
    assert.equal(
      log.shutdown(),
      first,
      "a second shutdown returns the first one's result",
    );
    assert.deepEqual(await first, { unsent: 0, timedOut: false });
    log.info("late");
    const st = log.stats();
    assert.equal(st.sent, 1200);
    assert.equal(st.afterShutdown, 1);
    assert.equal(s.reqs.length, 2);
  });

  it("shutdown gives up at its timeout", async () => {
    const s = await fakeServer([{ hang: true }]);
    const { log } = remoteLogger(s.url);
    log.info("stuck");
    const t0 = Date.now();
    const res = await log.shutdown(150);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res.timedOut, true);
    s.server.closeAllConnections?.();
  });

  it("the process still exits on its own, after beforeExit flushes", () => {
    const run = spawnSync(
      process.execPath,
      [new URL("./fixtures/exit.mjs", import.meta.url).pathname],
      { timeout: 10_000, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "exported 1");
  });
});

describe("never blocking", () => {
  it("logging stays fast with the server hanging, and the queue stays bounded", async () => {
    const s = await fakeServer(
      Array.from({ length: 50 }, () => ({ hang: true })),
    );
    const { log } = remoteLogger(s.url, { queueSize: 1000, batchSize: 100 });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) log.info("busy", { i });
    const perCall = (performance.now() - t0) / 100_000;
    const st = log.stats();
    assert.ok(perCall < 0.1, `${perCall} ms per call`);
    assert.ok(st.queued <= 1000);
    assert.ok(st.queueFull >= 98_000);
    await log.shutdown(100);
    s.server.closeAllConnections?.();
  });
});

describe("parsing", () => {
  it("reads Retry-After and partial success", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    assert.equal(retryAfterMs("12", now), 12_000);
    assert.equal(retryAfterMs("Wed, 11 Nov 2026 12:00:30 GMT", now), 30_000);
    assert.equal(retryAfterMs("soon", now), 0);
    assert.equal(retryAfterMs(null, now), 0);
    assert.equal(rejectedIn(""), 0);
    assert.equal(rejectedIn("not json"), 0);
  });
});
