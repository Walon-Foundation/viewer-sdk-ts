// Elysia: app.use(viewerPlugin(log)). Elysia is an optional peer dependency, tested with
// 1.4; it runs on Bun.
import { Elysia } from "elysia";
import { requestIdOf, requestStore, scopeFor } from "../context";
import type { Logger, RequestScope } from "../logger";
import {
  firstForwarded,
  type MiddlewareOptions,
  writeAccess,
} from "../middleware";

type State = { scope: RequestScope; startedAt: number; error?: unknown };

// biome-ignore lint/suspicious/noExplicitAny: Elysia's plugin type carries its own generics
export function viewerPlugin(log: Logger, opts: MiddlewareOptions = {}): any {
  const skip = new Set(opts.skipPaths ?? []);
  const states = new WeakMap<Request, State>();
  return new Elysia({ name: "viewer-sdk-ts", seed: opts })
    .onRequest(({ request, set }) => {
      const scope = scopeFor({
        requestId: request.headers.get("x-request-id"),
        traceparent: request.headers.get("traceparent"),
      });
      states.set(request, { scope, startedAt: performance.now() });
      set.headers["x-request-id"] = requestIdOf(scope);
      // Elysia offers no "run the rest inside" hook, so the scope is entered for the rest of
      // this request's async work.
      requestStore.enterWith(scope);
    })
    .onError({ as: "global" }, ({ request, error }) => {
      const s = states.get(request);
      if (s) s.error = error;
    })
    .onAfterResponse({ as: "global" }, ({ request, set, route }) => {
      const s = states.get(request);
      if (!s) return;
      const path = new URL(request.url).pathname;
      if (skip.has(path)) return;
      const status =
        typeof set.status === "number" ? set.status : Number(set.status) || 200;
      writeAccess(log, s.scope, {
        method: request.method,
        path,
        route: typeof route === "string" && route ? route : undefined,
        status,
        startedAt: s.startedAt,
        clientAddress: opts.trustProxy
          ? firstForwarded(request.headers.get("x-forwarded-for"))
          : undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
        error: s.error,
      });
    });
}
