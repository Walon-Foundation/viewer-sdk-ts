import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import {
  viewerMiddleware as expressMiddleware,
  viewerErrorHandler,
} from "#express";
import { viewerPlugin as fastifyPlugin } from "#fastify";
import { viewerMiddleware as honoMiddleware } from "#hono";
import { createLogger } from "#sdk";

const servers = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

function recording() {
  const lines = [];
  const log = createLogger({ console: "json", write: (l) => lines.push(l) });
  return { log, recs: () => lines.map((l) => JSON.parse(l)) };
}

const tick = () => new Promise((r) => setTimeout(r, 3));
const access = (recs) => recs.filter((r) => "http.response.status_code" in r);

describe("hono", () => {
  it("logs with the route, and handler logs share the request id", async () => {
    const { log, recs } = recording();
    const app = new Hono();
    app.use(honoMiddleware(log, { skipPaths: ["/healthz"] }));
    app.get("/invoices/:id", async (c) => {
      await tick();
      log.info("inside", { id: c.req.param("id") });
      return c.text("ok");
    });
    app.get("/boom", () => {
      throw new Error("hono broke");
    });
    app.get("/healthz", (c) => c.text("ok"));
    const res = await app.fetch(
      new Request("http://app.test/invoices/inv_9", {
        headers: { "x-request-id": "req_hono" },
      }),
    );
    assert.equal(res.headers.get("x-request-id"), "req_hono");
    const boom = await app.fetch(new Request("http://app.test/boom"));
    assert.equal(boom.status, 500);
    await app.fetch(new Request("http://app.test/healthz"));
    const got = recs();
    const [inside] = got;
    const [ok, failed] = access(got);
    assert.equal(inside.request_id, "req_hono");
    assert.equal(ok.request_id, "req_hono");
    assert.equal(ok["http.route"], "/invoices/:id");
    assert.equal(ok.msg, "GET /invoices/:id 200");
    assert.equal(failed.level, "error");
    assert.equal(failed["exception.message"], "hono broke");
    assert.equal(access(got).length, 2, "skip paths are skipped");
  });
});

describe("express", () => {
  it("logs with the matched route, and the error handler logs inside the request", async () => {
    const { log, recs } = recording();
    const app = express();
    app.use(expressMiddleware(log));
    app.get("/invoices/:id/pay", async (req, res) => {
      await tick();
      log.warn("card declined", { id: req.params.id });
      res.status(402).send("pay");
    });
    app.get("/boom", (_req, _res, next) =>
      setTimeout(() => next(new Error("express broke")), 2),
    );
    app.use(viewerErrorHandler(log));
    const server = createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${url}/invoices/inv_7/pay`, {
      headers: { "x-request-id": "req_express" },
    });
    await res.text();
    const boom = await fetch(`${url}/boom`);
    await boom.text();
    await tick();
    const got = recs();
    const declined = got.find((r) => r.msg === "card declined");
    const failed = got.find((r) => r.msg === "request failed");
    const [paid, boomAccess] = access(got);
    assert.equal(res.headers.get("x-request-id"), "req_express");
    assert.equal(declined.request_id, "req_express");
    assert.equal(paid["http.route"], "/invoices/:id/pay");
    assert.equal(paid.level, "warn");
    assert.equal(failed["exception.message"], "express broke");
    assert.equal(failed.request_id, boomAccess.request_id);
    assert.equal(boomAccess["http.response.status_code"], 500);
  });
});

describe("fastify", () => {
  it("logs with the route pattern, inside the request, including errors", async () => {
    const { log, recs } = recording();
    const app = Fastify();
    await app.register(fastifyPlugin, { log });
    app.get("/invoices/:id", async (req) => {
      await tick();
      log.info("inside", { id: req.params.id });
      return { ok: true };
    });
    app.get("/boom", async () => {
      throw new Error("fastify broke");
    });
    const res = await app.inject({
      url: "/invoices/inv_3",
      headers: { "x-request-id": "req_fastify" },
    });
    const boom = await app.inject({ url: "/boom" });
    await app.close();
    assert.equal(res.headers["x-request-id"], "req_fastify");
    assert.equal(boom.statusCode, 500);
    const got = recs();
    const [ok, failed] = access(got);
    assert.equal(got.find((r) => r.msg === "inside").request_id, "req_fastify");
    assert.equal(ok["http.route"], "/invoices/:id");
    assert.equal(ok.request_id, "req_fastify");
    assert.equal(failed.level, "error");
    assert.equal(failed["exception.message"], "fastify broke");
  });
});

// Elysia runs on Bun; under Node it's skipped.
describe("elysia", { skip: !process.versions.bun }, () => {
  it("logs with the route, keeps concurrent requests apart", async () => {
    const { Elysia } = await import("elysia");
    const { viewerPlugin } = await import("#elysia");
    const { log, recs } = recording();
    const app = new Elysia()
      .use(viewerPlugin(log))
      .get("/invoices/:id", async ({ params }) => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        log.info("inside", { id: params.id });
        return "ok";
      })
      .get("/boom", () => {
        throw new Error("elysia broke");
      });
    const res = await app.handle(
      new Request("http://app.test/invoices/inv_1", {
        headers: { "x-request-id": "req_elysia" },
      }),
    );
    assert.equal(res.headers.get("x-request-id"), "req_elysia");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.handle(
          new Request(`http://app.test/invoices/c${i}`, {
            headers: { "x-request-id": `rq${i}` },
          }),
        ),
      ),
    );
    const boom = await app.handle(new Request("http://app.test/boom"));
    assert.equal(boom.status, 500);
    await tick();
    const got = recs();
    for (const r of got.filter(
      (x) => x.msg === "inside" && x.id.startsWith("c"),
    ))
      assert.equal(r.request_id, `rq${r.id.slice(1)}`);
    const ok = access(got).find((r) => r.request_id === "req_elysia");
    assert.equal(ok["http.route"], "/invoices/:id");
    const failed = access(got).find(
      (r) => r["http.response.status_code"] === 500,
    );
    assert.equal(failed?.level, "error");
  });
});
