# TS SDK: working rules

This is a **library** (`@walon-foundation/viewer-sdk-ts`) that other projects install. It is not a Bun app.
Spec: `../../docs/spec.md`, section 9 (SDK-01 … SDK-10 and 9.3).

## Runtimes
- Must run on **Node >= 20 and Bun >= 1.1**. Every feature works on both.
- No `Bun.*` APIs and no Bun-only modules in `src/`. Use web standards (`fetch`, `Request`, `Response`,
  `CompressionStream`) and `node:` built-ins that Bun also implements (`node:async_hooks` for `AsyncLocalStorage`).
- `tsconfig.json` loads only Node types on purpose, so Bun-only code fails the typecheck.

## Backend-agnostic
- The core (`src/index.ts` and what it imports) never imports a web framework.
- Request support is built in layers: `runWithRequest` (AsyncLocalStorage), then `wrapFetch` (Web `Request → Response`)
  and `nodeMiddleware` (`req, res, next`), then optional thin adapters exported as subpaths (`/hono`, `/express`,
  `/fastify`, `/elysia`) that list their framework as an optional peer dependency.

## Dependencies
- **Zero runtime dependencies.** Dev dependencies are pinned to exact versions.

## Never break the host app
- Logging never throws to the caller, never blocks a request, and never grows memory without bound (SDK-03, SDK-04).

## Commands (Bun is the package manager and test runner here)
- `bun install`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun test`
- The build (tsdown) outputs ESM + CJS + `.d.ts` to `dist/`. Before a release, pack it (`bun pm pack`) and import it
  from a scratch project with **both** `node` and `bun`, using both `import` and `require`.
- Publish: `npm publish` (`publishConfig.access` is already `public`).
