# viewer-sdk-ts

The logger for the Viewer logging platform, for **Node ≥ 20 and Bun ≥ 1.1**, with **no
runtime dependencies**. It writes structured logs to the console and sends them to Viewer
over OTLP/HTTP, and it works with any backend framework.

> Work in progress: the framework adapters (Hono, Express, Fastify, Elysia) follow.

```bash
bun add @walon-foundation/viewer-sdk-ts   # or: npm i @walon-foundation/viewer-sdk-ts
```

```ts
import { createLogger } from "@walon-foundation/viewer-sdk-ts";

const log = createLogger({ service: "billing", env: "prod" }); // the rest from env

log.info("invoice created", { invoiceId, amount: 4200 });
log.error("payment failed", { err });
log.child({ userId }).warn("retrying");
await log.shutdown(); // sends what is queued, waiting at most 5 s
```

## Settings

| Option | Environment | Default |
|---|---|---|
| `endpoint` | `VIEWER_ENDPOINT` | none: console only |
| `apiKey` | `VIEWER_API_KEY` | none: console only |
| `service` | `VIEWER_SERVICE` | `unknown_service` |
| `env` | `VIEWER_ENV`, then `NODE_ENV` | `development` |
| `level` | `VIEWER_LEVEL` | `info` |
| `console` | – | `"auto"`: pretty in development, JSON lines in production; `false` to turn off |

Without an endpoint and an API key the logger writes to the console only, which suits local
development and tests. If only one of the two is set, it says so once on stderr.

## Behaviour to know

- **It never takes your program down.** A log call returns at once and never throws.
  Circular objects, deep nesting, bigints and throwing getters all have a fixed form.
- **Keys stay as you write them**: `invoiceId` is sent as `invoiceId`.
- **Errors** under any key add `exception.type`, `exception.message`,
  `exception.stacktrace` and a short `exception.cause` chain.
- **`fatal` does not exit.** It records the log at the fatal level; your program decides
  what happens next.

## Requests

Request support works with any backend, in layers:

1. **Context, anywhere.** `log.runWithRequest(meta, fn)` runs `fn` as a request. Every log
   call inside it, by any logger and however deep, carries `request_id` and the trace ids.
2. **Two middleware shapes** that cover nearly every server:
   - `log.wrapFetch(handler)` for web-standard `(Request) => Response` handlers: Bun.serve,
     Hono, Elysia, Next.js route handlers;
   - `log.nodeMiddleware()` for `(req, res, next)`: Express, Connect, Fastify through middie,
     raw `node:http`.

```ts
Bun.serve({ fetch: log.wrapFetch((req) => new Response("ok")) });
app.use(log.nodeMiddleware({ skipPaths: ["/healthz"] }));
```

Each request:
- reads `X-Request-ID` or makes one, and echoes it on the response;
- reads a W3C `traceparent` header for the trace and span ids;
- writes one access log: method, route or path, status, `duration_ms`, client address and
  user agent. 5xx logs at `error`, 4xx at `warn`, the rest at `info`. A thrown handler is
  logged as a 500 and thrown again; an aborted request is logged as 499.

Bodies are never buffered, so streaming responses stream. `trustProxy: true` reads the
client address from `X-Forwarded-For`; turn it on only behind a proxy that sets it.

## Sending

Records go into a bounded queue (10 000) and are sent in batches of up to 500, or every
second, as OTLP/HTTP JSON with gzip. Failures are retried with backoff (at most five tries,
honouring `Retry-After`). When the queue is full the oldest record is dropped. Nothing is
lost silently: `log.stats()` counts every drop, and the next batch that gets through carries
a warning saying how many were dropped.

`await log.flush()` sends what is queued; `await log.shutdown()` does that and stops. Both
wait at most five seconds by default and never reject: they resolve with what was left.

The timer is `unref`'d, so it never keeps your process alive. When the event loop empties
(`beforeExit`), queued records are flushed. The SDK adds no `SIGINT`/`SIGTERM` listener
unless you pass `handleSignals: true`; then it flushes and lets the signal end the process as
it would have. Otherwise call `await log.shutdown()` in your own shutdown code.

`exporter: { export(records) }` replaces HTTP with your own sink.

Licensed under MIT.
