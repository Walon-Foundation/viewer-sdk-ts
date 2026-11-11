import { requestIdOf, requestStore, scopeFor } from "./context";
import type { Logger, RequestScope } from "./logger";

export interface MiddlewareOptions {
  /** Paths, such as /healthz, that get no access log (they still get a request id). */
  skipPaths?: string[];
  /** Read the client address from X-Forwarded-For. Only behind a proxy that sets it. */
  trustProxy?: boolean;
}

export interface FetchOptions extends MiddlewareOptions {
  /** The matched route pattern, if your router knows it: "/invoices/:id". */
  route?: (req: Request) => string | undefined;
}

type AccessInfo = {
  method: string;
  path: string;
  route?: string;
  status: number;
  startedAt: number;
  clientAddress?: string;
  userAgent?: string;
  error?: unknown;
};

/** access writes the request's one log: error for 5xx, warn for 4xx, info otherwise (SDK-10). */
export function writeAccess(
  log: Logger,
  scope: RequestScope,
  a: AccessInfo,
): void {
  const level = a.status >= 500 ? "error" : a.status >= 400 ? "warn" : "info";
  const attrs: Record<string, unknown> = {
    "http.request.method": a.method,
    ...(a.route ? { "http.route": a.route } : {}),
    "url.path": a.path,
    "http.response.status_code": a.status,
    duration_ms: Math.round((performance.now() - a.startedAt) * 1000) / 1000,
  };
  if (a.clientAddress) attrs["client.address"] = a.clientAddress;
  if (a.userAgent) attrs["user_agent.original"] = a.userAgent;
  if (a.error !== undefined)
    attrs.err = a.error instanceof Error ? a.error : new Error(String(a.error));
  // Logged inside the request's scope, whatever async context the response finished in.
  requestStore.run(scope, () =>
    log.log(level, `${a.method} ${a.route ?? a.path} ${a.status}`, attrs),
  );
}

const firstForwarded = (xff: string | null | undefined): string | undefined =>
  xff?.split(",")[0]?.trim() || undefined;

type FetchHandler<A extends unknown[]> = (
  req: Request,
  ...rest: A
) => Response | Promise<Response>;

/**
 * wrapFetch wraps a web-standard handler, (Request) => Response: Bun.serve, Hono, Elysia,
 * Next.js route handlers. The body is passed through, never buffered.
 */
export function wrapFetch<A extends unknown[]>(
  log: Logger,
  handler: FetchHandler<A>,
  opts: FetchOptions = {},
): FetchHandler<A> {
  const skip = new Set(opts.skipPaths ?? []);
  return async (req: Request, ...rest: A): Promise<Response> => {
    const startedAt = performance.now();
    const scope = scopeFor({
      requestId: req.headers.get("x-request-id"),
      traceparent: req.headers.get("traceparent"),
    });
    const path = safePath(req.url);
    const info = (status: number, error?: unknown): AccessInfo => ({
      method: req.method,
      path,
      route: safeRoute(opts.route, req),
      status,
      startedAt,
      clientAddress: opts.trustProxy
        ? (firstForwarded(req.headers.get("x-forwarded-for")) ??
          peer(req, rest))
        : peer(req, rest),
      userAgent: req.headers.get("user-agent") ?? undefined,
      error,
    });
    let res: Response;
    try {
      res = await requestStore.run(scope, () => handler(req, ...rest));
    } catch (e) {
      if (!skip.has(path)) writeAccess(log, scope, info(500, e));
      throw e;
    }
    res = withHeader(res, "X-Request-ID", requestIdOf(scope));
    if (!skip.has(path)) writeAccess(log, scope, info(res.status));
    return res;
  };
}

/** A Bun.serve handler gets the server as its second argument: server.requestIP(req). */
function peer(req: Request, rest: unknown[]): string | undefined {
  const server = rest[0] as
    | { requestIP?: (r: Request) => { address?: string } | null }
    | undefined;
  try {
    return server?.requestIP?.(req)?.address ?? undefined;
  } catch {
    return undefined;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function safeRoute(
  route: FetchOptions["route"],
  req: Request,
): string | undefined {
  try {
    return route?.(req);
  } catch {
    return undefined;
  }
}

/** withHeader sets a header, copying the response when its headers are immutable. */
function withHeader(res: Response, name: string, value: string): Response {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set(name, value);
    return copy;
  }
}

/** The parts of node:http's IncomingMessage and ServerResponse (and Express's) used here. */
export interface NodeRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface NodeResponse {
  statusCode: number;
  writableFinished?: boolean;
  setHeader(name: string, value: string): unknown;
  once(event: "finish" | "close", fn: () => void): unknown;
}

export type NodeMiddleware = (
  req: NodeRequest,
  res: NodeResponse,
  next?: (err?: unknown) => void,
) => void;

const header = (req: NodeRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * nodeMiddleware is (req, res, next) middleware: Express, Connect, Fastify through middie,
 * or raw node:http. Later middleware and the handler run inside the request's scope, and
 * an aborted request is logged too.
 */
export function nodeMiddleware(
  log: Logger,
  opts: MiddlewareOptions = {},
): NodeMiddleware {
  const skip = new Set(opts.skipPaths ?? []);
  return (req, res, next) => {
    const startedAt = performance.now();
    const scope = scopeFor({
      requestId: header(req, "x-request-id"),
      traceparent: header(req, "traceparent"),
    });
    try {
      res.setHeader("X-Request-ID", requestIdOf(scope));
    } catch {
      // headers already sent: the id still goes in the logs
    }
    const raw = req.originalUrl ?? req.url ?? "/";
    const path = raw.split("?")[0] || "/";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (skip.has(path)) return;
      // Express sets req.route once a route matched; aborted requests never finished.
      const routePath =
        typeof req.route?.path === "string"
          ? `${req.baseUrl ?? ""}${req.route.path}`
          : undefined;
      writeAccess(log, scope, {
        method: req.method ?? "GET",
        path,
        route: routePath,
        status: res.writableFinished === false ? 499 : res.statusCode,
        startedAt,
        clientAddress: opts.trustProxy
          ? (firstForwarded(header(req, "x-forwarded-for")) ??
            req.socket?.remoteAddress)
          : req.socket?.remoteAddress,
        userAgent: header(req, "user-agent"),
      });
    };
    res.once("finish", finish);
    res.once("close", finish);
    requestStore.run(scope, () => next?.());
  };
}
