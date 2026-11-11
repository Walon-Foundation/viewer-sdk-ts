import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { after, describe, it } from "node:test";
import { parseTraceparent, validRequestId } from "#internal";
import { createLogger } from "#sdk";

// Servers started by the tests, closed once at the end (Bun 1.2's node:test doesn't allow
// after() inside a test).
const servers = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

/** A logger whose records land in an array, as plain objects. */
function recording(opts = {}) {
  const lines = [];
  const log = createLogger({
    console: "json",
    level: "trace",
    ...opts,
    write: (l) => lines.push(l),
  });
  return { log, recs: () => lines.map((l) => JSON.parse(l)) };
}

const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SID = "00f067aa0ba902b7";

describe("request context", () => {
  it("follows the request across await, timers, promises and events", async () => {
    const { log, recs } = recording();
    const em = new EventEmitter();
    em.on("tick", () => log.info("from an event"));
    await log.runWithRequest({ requestId: "req_ctx" }, async () => {
      log.info("start");
      await new Promise((r) => setTimeout(r, 5));
      log.info("after await");
      await new Promise((r) =>
        setTimeout(() => {
          log.info("in a timer");
          r();
        }, 5),
      );
      await Promise.resolve().then(() => log.info("in a then"));
      em.emit("tick");
    });
    log.info("outside");
    const got = recs();
    assert.equal(got.length, 6);
    for (const r of got.slice(0, 5))
      assert.equal(r.request_id, "req_ctx", r.msg);
    assert.equal(got[5].request_id, undefined);
  });

  it("keeps concurrent requests apart", async () => {
    const { log, recs } = recording();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        log.runWithRequest(
          { requestId: `r${i}`, attributes: { i } },
          async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 20));
            log.info("work");
            await new Promise((r) => setTimeout(r, Math.random() * 20));
            log.child({ step: 2 }).info("more");
          },
        ),
      ),
    );
    const got = recs();
    assert.equal(got.length, 200);
    for (const r of got) assert.equal(r.request_id, `r${r.i}`);
  });

  it("any logger used inside a request picks it up, with the trace", () => {
    const a = recording();
    const b = recording();
    a.log.runWithRequest(
      { requestId: "shared", traceparent: `00-${TID}-${SID}-01` },
      () => b.log.warn("other logger"),
    );
    const [r] = b.recs();
    assert.equal(r.request_id, "shared");
    assert.equal(r.trace_id, TID);
    assert.equal(r.span_id, SID);
    assert.equal(a.log.current(), a.log);
  });

  it("makes a request id when the incoming one is missing or unusable", () => {
    const { log, recs } = recording();
    for (const bad of [
      undefined,
      "",
      "has space",
      "x".repeat(129),
      "new\nline",
    ])
      log.runWithRequest({ requestId: bad }, () => log.info("x"));
    for (const r of recs()) assert.match(r.request_id, /^[0-9a-f]{32}$/);
    assert.equal(validRequestId("req-123_ok"), true);
  });

  it("reads W3C traceparent strictly", () => {
    const cases = {
      [`00-${TID}-${SID}-01`]: true,
      [`01-${TID}-${SID}-01-more`]: true,
      [`ff-${TID}-${SID}-01`]: false,
      [`00-${TID}-${SID}-01-more`]: false,
      [`00-${TID.toUpperCase()}-${SID}-01`]: false,
      [`00-${"0".repeat(32)}-${SID}-01`]: false,
      [`00-${TID}-${"0".repeat(16)}-01`]: false,
      [`00-${TID}-${SID}`]: false,
      garbage: false,
    };
    for (const [h, ok] of Object.entries(cases))
      assert.equal(Boolean(parseTraceparent(h)), ok, h);
  });
});

describe("wrapFetch", () => {
  const call = (handler, init = {}, path = "/invoices?x=1") =>
    handler(new Request(`http://app.test${path}`, init));

  it("logs one access record per request, at a level from the status", async () => {
    for (const [status, level] of [
      [200, "info"],
      [302, "info"],
      [404, "warn"],
      [503, "error"],
    ]) {
      const { log, recs } = recording();
      const h = log.wrapFetch(() => new Response("x", { status }));
      const res = await call(h, {
        method: "POST",
        headers: { "user-agent": "curl/8" },
      });
      assert.equal(res.status, status);
      const [a] = recs();
      assert.equal(a.level, level);
      assert.equal(a.msg, `POST /invoices ${status}`);
      assert.equal(a["http.request.method"], "POST");
      assert.equal(a["url.path"], "/invoices");
      assert.equal(a["http.response.status_code"], status);
      assert.equal(a["user_agent.original"], "curl/8");
      assert.equal(typeof a.duration_ms, "number");
    }
  });

  it("echoes or makes the request id, and the handler's logs share it", async () => {
    const { log, recs } = recording();
    const h = log.wrapFetch(async () => {
      await new Promise((r) => setTimeout(r, 2));
      log.info("inside");
      return new Response("ok");
    });
    const res = await call(h, {
      headers: {
        "x-request-id": "req_from_client",
        traceparent: `00-${TID}-${SID}-01`,
      },
    });
    assert.equal(res.headers.get("x-request-id"), "req_from_client");
    const [inside, access] = recs();
    assert.equal(inside.request_id, "req_from_client");
    assert.equal(access.request_id, "req_from_client");
    assert.equal(inside.trace_id, TID);
    const fresh = await call(h);
    assert.match(fresh.headers.get("x-request-id"), /^[0-9a-f]{32}$/);
  });

  it("logs a thrown handler as a 500 and throws it again", async () => {
    const { log, recs } = recording();
    const h = log.wrapFetch(() => {
      throw new Error("handler broke");
    });
    await assert.rejects(call(h), /handler broke/);
    const [a] = recs();
    assert.equal(a.level, "error");
    assert.equal(a["http.response.status_code"], 500);
    assert.equal(a["exception.message"], "handler broke");
  });

  it("passes a streaming body through without buffering it", async () => {
    const { log } = recording();
    let pulled = 0;
    const body = new ReadableStream({
      async pull(c) {
        pulled++;
        await new Promise((r) => setTimeout(r, 10));
        if (pulled > 3) c.close();
        else c.enqueue(new TextEncoder().encode(`chunk ${pulled}\n`));
      },
    });
    const res = await call(log.wrapFetch(() => new Response(body)));
    assert.ok(pulled <= 1, "the wrapper must not read the body");
    assert.equal(await res.text(), "chunk 1\nchunk 2\nchunk 3\n");
  });

  it("copies a response whose headers can't change", async () => {
    const { log } = recording();
    const res = await call(
      log.wrapFetch(() => Response.redirect("http://app.test/elsewhere", 302)),
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "http://app.test/elsewhere");
    assert.match(res.headers.get("x-request-id"), /^[0-9a-f]{32}$/);
  });

  it("takes a route, skip paths, and the forwarded address when trusted", async () => {
    const { log, recs } = recording();
    const opts = {
      route: () => "/invoices/:id",
      skipPaths: ["/healthz"],
      trustProxy: true,
    };
    const h = log.wrapFetch(() => new Response("ok"), opts);
    await call(
      h,
      { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } },
      "/invoices/inv_9",
    );
    await call(h, {}, "/healthz");
    const got = recs();
    assert.equal(got.length, 1);
    assert.equal(got[0]["http.route"], "/invoices/:id");
    assert.equal(got[0].msg, "GET /invoices/:id 200");
    assert.equal(got[0]["client.address"], "203.0.113.7");
  });
});

describe("nodeMiddleware", () => {
  async function serve(log, handler, opts) {
    const mw = log.nodeMiddleware(opts);
    const server = createServer((req, res) =>
      mw(req, res, () => handler(req, res)),
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  it("logs the request, echoes the id, and the handler's logs share it", async () => {
    const { log, recs } = recording();
    const url = await serve(log, async (_req, res) => {
      await new Promise((r) => setTimeout(r, 2));
      log.warn("inside handler");
      res.statusCode = 402;
      res.end("pay");
    });
    const res = await fetch(`${url}/invoices/inv_7/pay?x=1`, {
      method: "POST",
      headers: { "x-request-id": "req_node" },
    });
    await res.text();
    assert.equal(res.headers.get("x-request-id"), "req_node");
    await new Promise((r) => setTimeout(r, 20));
    const [inside, access] = recs();
    assert.equal(inside.request_id, "req_node");
    assert.equal(access.request_id, "req_node");
    assert.equal(access.level, "warn");
    assert.equal(access["url.path"], "/invoices/inv_7/pay");
    assert.equal(access["http.response.status_code"], 402);
    assert.equal(access["client.address"], "127.0.0.1");
  });

  it("logs an aborted request as 499, and skips skip paths", async () => {
    const { log, recs } = recording();
    const url = await serve(
      log,
      (req, res) => {
        if (req.url === "/healthz") return res.end("ok");
        // never answers: the client gives up
      },
      { skipPaths: ["/healthz"] },
    );
    await (await fetch(`${url}/healthz`)).text();
    await new Promise((resolve) => {
      const req = request(`${url}/slow`);
      req.on("error", () => resolve());
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 50));
    const got = recs();
    assert.equal(got.length, 1);
    assert.equal(got[0]["http.response.status_code"], 499);
    assert.equal(got[0]["url.path"], "/slow");
  });
});
