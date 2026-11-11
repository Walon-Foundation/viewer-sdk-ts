// Hono: app.use(viewerMiddleware(log)). Hono is an optional peer dependency.
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { requestIdOf, requestStore, scopeFor } from "../context";
import type { Logger } from "../logger";
import {
  firstForwarded,
  type MiddlewareOptions,
  writeAccess,
} from "../middleware";

export function viewerMiddleware(
  log: Logger,
  opts: MiddlewareOptions = {},
): MiddlewareHandler {
  const skip = new Set(opts.skipPaths ?? []);
  return async (c, next) => {
    const startedAt = performance.now();
    const scope = scopeFor({
      requestId: c.req.header("x-request-id"),
      traceparent: c.req.header("traceparent"),
    });
    c.header("X-Request-ID", requestIdOf(scope));
    await requestStore.run(scope, () => next());
    const path = c.req.path;
    if (skip.has(path)) return;
    let route: string | undefined;
    try {
      route = routePath(c, -1); // the handler's pattern, not this middleware's "*"
    } catch {
      route = undefined;
    }
    writeAccess(log, scope, {
      method: c.req.method,
      path,
      route: route && !route.includes("*") ? route : undefined,
      status: c.res.status,
      startedAt,
      clientAddress: opts.trustProxy
        ? firstForwarded(c.req.header("x-forwarded-for"))
        : undefined,
      userAgent: c.req.header("user-agent"),
      error: c.error,
    });
  };
}
