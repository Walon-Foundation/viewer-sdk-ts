// Sends to a real Viewer, for the platform's end-to-end tests (plan7 T1–T3). The platform
// runs it with VIEWER_ENDPOINT and VIEWER_API_KEY set, then reads the logs back through its
// API. It prints one JSON line of facts the test checks. Not part of the unit suite.
import { createServer } from "node:http";
import { createLogger } from "#sdk";

const mode = process.argv[2];
const log = createLogger({
  service: "billing",
  env: "prod",
  console: false,
  level: "debug",
});
const out = {};

if (mode === "records") {
  // T1: fields, levels, attributes and exceptions.
  log.child({ userId: "u_42" }).error("payment failed", {
    invoiceId: "inv_1",
    amount: 4200,
    retry: false,
    meta: { plan: "pro" },
    err: new RangeError("card declined", { cause: new Error("socket closed") }),
  });
  log.debug("cache miss", { took_ms: 1500 });
} else if (mode === "requests") {
  // T2: wrapFetch and nodeMiddleware, each with a handler log sharing the request id.
  const fetchHandler = log.wrapFetch(async (req) => {
    await new Promise((r) => setTimeout(r, 2));
    log.warn("card declined, retrying", { path: new URL(req.url).pathname });
    return new Response("pay", { status: 402 });
  });
  const res = await fetchHandler(
    new Request("http://app.test/invoices/inv_7/pay", {
      method: "POST",
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    }),
  );
  out.fetchRequestId = res.headers.get("x-request-id");

  const mw = log.nodeMiddleware();
  const server = createServer((req, res2) =>
    mw(req, res2, async () => {
      await new Promise((r) => setTimeout(r, 2));
      log.info("handled in node", { path: req.url });
      res2.end("ok");
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r2 = await fetch(`http://127.0.0.1:${server.address().port}/orders`);
  await r2.text();
  out.nodeRequestId = r2.headers.get("x-request-id");
  server.close();
  await new Promise((r) => setTimeout(r, 20));
} else if (mode === "outage") {
  // T3: the platform's proxy refuses the first five requests: five tries, then a drop.
  log.info("during the outage");
  await log.flush(20_000);
  log.info("back again");
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

const res = await log.shutdown(20_000);
out.stats = log.stats();
out.unsent = res.unsent;
console.log(JSON.stringify(out));
