// Fastify: await app.register(viewerPlugin, { log }). Fastify is an optional peer
// dependency; only its types are used.
import type { FastifyPluginCallback } from "fastify";
import { requestIdOf, requestStore, scopeFor } from "../context";
import type { Logger, RequestScope } from "../logger";
import {
  firstForwarded,
  type MiddlewareOptions,
  writeAccess,
} from "../middleware";

export interface ViewerPluginOptions extends MiddlewareOptions {
  log: Logger;
}

type State = { scope: RequestScope; startedAt: number; error?: unknown };
const state = new WeakMap<object, State>();

const plugin: FastifyPluginCallback<ViewerPluginOptions> = (
  app,
  opts,
  done,
) => {
  const { log } = opts;
  const skip = new Set(opts.skipPaths ?? []);
  const header = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  app.addHook("onRequest", (req, reply, next) => {
    const scope = scopeFor({
      requestId: header(req.headers["x-request-id"]),
      traceparent: header(req.headers.traceparent),
    });
    state.set(req, { scope, startedAt: performance.now() });
    reply.header("X-Request-ID", requestIdOf(scope));
    requestStore.run(scope, () => next()); // the rest of the hooks and the handler run inside
  });
  app.addHook("onError", (req, _reply, error, next) => {
    const s = state.get(req);
    if (s) s.error = error;
    next();
  });
  app.addHook("onResponse", (req, reply, next) => {
    const s = state.get(req);
    const path = req.url.split("?")[0] || "/";
    if (s && !skip.has(path)) {
      writeAccess(log, s.scope, {
        method: req.method,
        path,
        route: req.routeOptions?.url,
        status: reply.statusCode,
        startedAt: s.startedAt,
        clientAddress: opts.trustProxy
          ? (firstForwarded(header(req.headers["x-forwarded-for"])) ?? req.ip)
          : req.ip,
        userAgent: header(req.headers["user-agent"]),
        error: s.error,
      });
    }
    next();
  });
  done();
};

// Like fastify-plugin: the hooks apply to the whole app, not only this plugin's scope.
(plugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] =
  true;
(plugin as unknown as Record<symbol, unknown>)[
  Symbol.for("fastify.display-name")
] = "viewer-sdk-ts";

export const viewerPlugin: FastifyPluginCallback<ViewerPluginOptions> = plugin;
