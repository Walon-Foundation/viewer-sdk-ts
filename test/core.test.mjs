import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger, LEVELS, parseLevel } from "#sdk";
import { capture, stderrLines, withEnv } from "./helpers.mjs";

const clean = {
  VIEWER_ENDPOINT: undefined,
  VIEWER_API_KEY: undefined,
  VIEWER_SERVICE: undefined,
  VIEWER_ENV: undefined,
  VIEWER_LEVEL: undefined,
  NODE_ENV: undefined,
};

describe("levels", () => {
  it("match OpenTelemetry severity numbers (SDK-01)", () => {
    assert.deepEqual(LEVELS, {
      trace: 1,
      debug: 5,
      info: 9,
      warn: 13,
      error: 17,
      fatal: 21,
    });
    assert.equal(parseLevel("WARNING"), "warn");
    assert.equal(parseLevel(" Error "), "error");
    assert.equal(parseLevel("loud"), undefined);
  });

  it("drop records below the level", () => {
    const { log, lines } = capture({ level: "warn" });
    log.info("hidden");
    log.warn("shown");
    assert.equal(lines.length, 1);
    assert.equal(log.isEnabled("info"), false);
  });
});

describe("console", () => {
  it("writes JSON lines with the record's fields", () => {
    const { log, json } = capture({ service: "billing", env: "prod" });
    log.child({ userId: "u1" }).error("payment failed", {
      invoiceId: "inv_1",
      amount: 4200,
      tags: ["a"],
      big: 12n,
      at: new Date(0),
    });
    const [r] = json();
    assert.equal(r.level, "error");
    assert.equal(r.service, "billing");
    assert.equal(r.env, "prod");
    assert.equal(r.msg, "payment failed");
    assert.equal(r.userId, "u1"); // keys stay as written
    assert.equal(r.invoiceId, "inv_1");
    assert.equal(r.amount, 4200);
    assert.deepEqual(r.tags, ["a"]);
    assert.equal(r.big, "12");
    assert.equal(r.at, "1970-01-01T00:00:00.000Z");
    assert.match(r.time, /^\d{4}-\d\d-\d\dT/);
  });

  it("writes readable text in development, with the stack under the line", () => {
    const { log, lines } = capture({ console: "auto", env: "development" });
    log.warn("slow request", { path: "/invoices", note: "two words", ms: 812 });
    log.error("boom", { err: new TypeError("bad input") });
    assert.match(
      lines[0],
      /^\d\d:\d\d:\d\d\.\d{3} WARN {2}slow request {2}path=\/invoices {2}note="two words" {2}ms=812\n$/,
    );
    const [first, ...stack] = lines[1].trimEnd().split("\n");
    assert.match(
      first,
      /ERROR boom {2}err="bad input" {2}exception\.type=TypeError/,
    );
    assert.ok(!first.includes("stacktrace"));
    assert.ok(stack.length > 0 && stack.every((l) => l.startsWith("    ")));
  });

  it("is JSON in production and can be turned off", () => {
    const prod = capture({ console: "auto", env: "production" });
    prod.log.info("x");
    assert.doesNotThrow(() => JSON.parse(prod.lines[0]));
    const off = capture({ console: false });
    off.log.error("y");
    assert.equal(off.lines.length, 0);
  });
});

describe("attributes", () => {
  it("child binds attributes without touching the parent (SDK-02)", () => {
    const { log, json } = capture();
    const a = log.child({ k: "a" });
    const b = a.child({ k2: "b" });
    a.child({ k3: "c" });
    b.info("x");
    a.info("y", { k: "override" });
    const [x, y] = json();
    assert.equal(x.k, "a");
    assert.equal(x.k2, "b");
    assert.equal(x.k3, undefined);
    assert.equal(y.k, "override");
  });

  it("errors add exception fields with a short cause chain (SDK-07)", () => {
    const { log, json } = capture();
    const root = new Error("socket closed");
    log.error("payment failed", {
      err: new RangeError("card declined", { cause: root }),
    });
    const [r] = json();
    assert.equal(r.err, "card declined");
    assert.equal(r["exception.type"], "RangeError");
    assert.equal(r["exception.message"], "card declined");
    assert.equal(r["exception.cause"], "Error: socket closed");
    assert.match(r["exception.stacktrace"], /RangeError: card declined/);
  });

  it("odd values have a fixed form and never throw", () => {
    const { log, json } = capture();
    const loop = { name: "loop" };
    loop.self = loop;
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const trap = {
      get boom() {
        throw new Error("no");
      },
    };
    assert.doesNotThrow(() =>
      log.info("odd", {
        loop,
        deep,
        trap,
        nan: NaN,
        fn: function named() {},
        bytes: new Uint8Array([104, 105]),
        none: undefined,
      }),
    );
    const [r] = json();
    assert.equal(r.loop.self, "[circular]");
    assert.equal(r.deep.a.b.c.d.e, "[depth]");
    assert.equal(r.trap.boom, "[unserialisable]");
    assert.equal(r.nan, "NaN");
    assert.equal(r.fn, "[function named]");
    assert.equal(r.bytes, "aGk=");
    assert.equal(r.none, null);
  });

  it("a non-object second argument is kept, not lost", () => {
    const { log, json } = capture();
    log.info("count", 3);
    log.info("failed", new Error("x"));
    const [a, b] = json();
    assert.equal(a.value, 3);
    assert.equal(b["exception.message"], "x");
  });
});

describe("settings", () => {
  it("come from the environment", async () => {
    await withEnv(
      {
        ...clean,
        VIEWER_SERVICE: "billing",
        VIEWER_ENV: "staging",
        VIEWER_LEVEL: "debug",
      },
      () => {
        const lines = [];
        const log = createLogger({
          console: "json",
          write: (l) => lines.push(l),
        });
        log.debug("d");
        const r = JSON.parse(lines[0]);
        assert.equal(r.service, "billing");
        assert.equal(r.env, "staging");
      },
    );
  });

  it("fall back to NODE_ENV and unknown_service", async () => {
    await withEnv({ ...clean, NODE_ENV: "production" }, () => {
      const lines = [];
      createLogger({ write: (l) => lines.push(l) }).info("x");
      const r = JSON.parse(lines[0]); // production means JSON by default
      assert.equal(r.service, "unknown_service");
      assert.equal(r.env, "production");
    });
  });

  it("half a configuration is said once on stderr; none at all says nothing", async () => {
    const said = await stderrLines(() =>
      withEnv(clean, () => {
        createLogger({ endpoint: "https://v.example.org", console: false });
        createLogger({ apiKey: "k", console: false });
        createLogger({ endpoint: "not a url", apiKey: "k", console: false });
        createLogger({ console: false });
      }),
    );
    assert.equal(said.length, 3);
    assert.match(said[0], /no API key/);
    assert.match(said[1], /no endpoint/);
    assert.match(said[2], /not an http\(s\) URL/);
  });
});

describe("never throws", () => {
  it("survives a console writer that throws", async () => {
    const log = createLogger({
      console: "json",
      write: () => {
        throw new Error("stdout closed");
      },
    });
    const said = await stderrLines(() => {
      assert.doesNotThrow(() => log.info("a"));
      assert.doesNotThrow(() => log.info("b"));
    });
    assert.ok(said.length <= 1);
  });
});
