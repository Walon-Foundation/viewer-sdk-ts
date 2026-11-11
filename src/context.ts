import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestScope } from "./logger";

// One store for the process: any logger used inside a request picks the request up, even
// one created elsewhere, the way a context does in the Go SDK.
export const requestStore: AsyncLocalStorage<RequestScope> =
  new AsyncLocalStorage<RequestScope>();

export interface RequestMeta {
  /** The incoming X-Request-ID; a new id is made when it's missing or unusable. */
  requestId?: string | null;
  /** The incoming W3C traceparent header. */
  traceparent?: string | null;
  /** More attributes for every record in the request. */
  attributes?: Record<string, unknown>;
}

/** scopeFor builds a request's scope from what came in. */
export function scopeFor(meta: RequestMeta = {}): RequestScope {
  const id = validRequestId(meta.requestId)
    ? (meta.requestId as string)
    : newRequestId();
  const scope: RequestScope = {
    attributes: { request_id: id, ...meta.attributes },
  };
  const t = parseTraceparent(meta.traceparent);
  if (t) {
    scope.traceId = t.traceId;
    scope.spanId = t.spanId;
  }
  return scope;
}

export function requestIdOf(scope: RequestScope): string {
  return String(scope.attributes.request_id);
}

/** validRequestId accepts a short, plain id, so a client can't stuff a log line with it. */
export function validRequestId(id: string | null | undefined): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[\x21-\x7e]+$/.test(id)
  );
}

export function newRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

const HEX = /^[0-9a-f]+$/;
const ZERO32 = "0".repeat(32);
const ZERO16 = "0".repeat(16);

/** parseTraceparent reads version-traceid-spanid-flags, as the W3C spec allows. */
export function parseTraceparent(
  h: string | null | undefined,
): { traceId: string; spanId: string } | undefined {
  const v = h?.trim();
  if (!v || v.length < 55 || v[2] !== "-" || v[35] !== "-" || v[52] !== "-")
    return undefined;
  const version = v.slice(0, 2);
  if (version === "ff" || !HEX.test(version.toLowerCase())) return undefined;
  if (version === "00" && v.length !== 55) return undefined;
  if (v.length > 55 && v[55] !== "-") return undefined;
  const traceId = v.slice(3, 35);
  const spanId = v.slice(36, 52);
  if (
    !HEX.test(traceId) ||
    !HEX.test(spanId) ||
    !HEX.test(v.slice(53, 55).toLowerCase())
  )
    return undefined;
  if (traceId === ZERO32 || spanId === ZERO16) return undefined;
  return { traceId, spanId };
}
