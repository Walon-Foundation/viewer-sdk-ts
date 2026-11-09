# @walon-foundation/viewer-sdk-ts

Logger SDK for the Viewer logging platform. Works on Node (>= 20) and Bun, with any backend framework.

> Work in progress: the API below is the planned shape.

```bash
bun add @walon-foundation/viewer-sdk-ts   # or: npm i @walon-foundation/viewer-sdk-ts
```

```ts
import { createLogger } from "@walon-foundation/viewer-sdk-ts";

const log = createLogger({ service: "billing", env: "prod" }); // VIEWER_ENDPOINT / VIEWER_API_KEY from env
log.info("invoice created", { invoiceId: "inv_123", amount: 4200 });
```

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run build   # ESM + CJS + types into dist/
bun test
```

## License

MIT
