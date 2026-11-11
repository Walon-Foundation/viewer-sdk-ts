// Express: app.use(viewerMiddleware(log)) first, and app.use(viewerErrorHandler(log)) last.
// Express is an optional peer dependency; only its types are used.
import type { ErrorRequestHandler, RequestHandler } from "express";
import { requestStore } from "../context";
import type { Logger } from "../logger";
import {
  type MiddlewareOptions,
  type NodeMiddleware,
  scopeOfRequest,
} from "../middleware";

export function viewerMiddleware(
  log: Logger,
  opts?: MiddlewareOptions,
): RequestHandler {
  const mw: NodeMiddleware = log.nodeMiddleware(opts);
  return (req, res, next) => mw(req, res, next);
}

/**
 * viewerErrorHandler logs an error a route passed on, inside its request, then hands it to
 * the next error handler, so Express's own response is unchanged.
 */
export function viewerErrorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, _res, next) => {
    const scope = scopeOfRequest(req);
    const write = () => log.error("request failed", { err });
    if (scope) requestStore.run(scope, write);
    else write();
    next(err);
  };
}
