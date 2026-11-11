# viewer-sdk-ts

The logger for the Viewer logging platform, for **Node ≥ 20 and Bun ≥ 1.1**, with **no
runtime dependencies**. It writes structured logs to the console and sends them to Viewer
over OTLP/HTTP, and it works with any backend framework.

> Work in progress: the logger, its settings and the console output are in. Sending to
> Viewer, request context and the framework adapters follow.

```bash
bun add @walon-foundation/viewer-sdk-ts   # or: npm i @walon-foundation/viewer-sdk-ts
```

```ts
import { createLogger } from "@walon-foundation/viewer-sdk-ts";

const log = createLogger({ service: "billing", env: "prod" }); // the rest from env

log.info("invoice created", { invoiceId, amount: 4200 });
log.error("payment failed", { err });
log.child({ userId }).warn("retrying");
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

Licensed under MIT.
