import type { Attributes, LogRecord } from "./record";
import { toBase64 } from "./record";

// The OTLP/JSON ExportLogsServiceRequest, written by hand to the opentelemetry-proto JSON
// mapping: camelCase names, int64 as strings, hex trace ids. A record encodes to the same
// JSON as the Go SDK's (plan7 1), checked against its golden file.

export const SCOPE_NAME = "viewer-sdk-ts";

const SEVERITY = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;
const MAX_DEPTH = 5;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export function encodeRequest(
  resource: Attributes,
  records: LogRecord[],
  observedNanos: string,
  version: string,
): string {
  return `{"resourceLogs":[{"resource":{"attributes":${encodeAttributes(resource)}},"scopeLogs":[{"scope":{"name":"${SCOPE_NAME}","version":"${version}"},"logRecords":[${records
    .map((r) => encodeRecord(r, observedNanos))
    .join(",")}]}]}]}`;
}

export function encodeRecord(r: LogRecord, observedNanos: string): string {
  let s = `{"timeUnixNano":"${r.timeUnixNano}","observedTimeUnixNano":"${observedNanos}","severityNumber":${SEVERITY[r.level]},"severityText":"${r.level.toUpperCase()}","body":{"stringValue":${JSON.stringify(r.message)}},"attributes":${encodeAttributes(r.attributes)}`;
  if (r.traceId) s += `,"traceId":"${r.traceId}"`;
  if (r.spanId) s += `,"spanId":"${r.spanId}"`;
  return `${s}}`;
}

function encodeAttributes(attrs: Attributes): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    parts.push(
      `{"key":${JSON.stringify(k)},"value":${anyValue(v, 0, new WeakSet())}}`,
    );
  }
  return `[${parts.join(",")}]`;
}

const str = (s: string): string => `{"stringValue":${JSON.stringify(s)}}`;

/** anyValue writes an OTLP AnyValue. It never throws. */
export function anyValue(
  v: unknown,
  depth: number,
  seen: WeakSet<object>,
): string {
  try {
    switch (typeof v) {
      case "string":
        return str(v);
      case "boolean":
        return `{"boolValue":${v}}`;
      case "number":
        if (Number.isSafeInteger(v)) return `{"intValue":"${v}"}`;
        if (!Number.isFinite(v)) return str(String(v));
        return `{"doubleValue":${v}}`;
      case "bigint":
        return v >= INT64_MIN && v <= INT64_MAX
          ? `{"intValue":"${v}"}`
          : str(v.toString());
      case "undefined":
        return "{}";
      case "function":
        return str(
          `[function ${(v as { name?: string }).name || "anonymous"}]`,
        );
      case "symbol":
        return str(v.toString());
    }
    if (v === null) return "{}";
    if (v instanceof Date) return str(rfc3339(v));
    if (v instanceof Error) return str(v.message);
    if (v instanceof Uint8Array) return `{"bytesValue":"${toBase64(v)}"}`;
    const o = v as object;
    if (seen.has(o)) return str("[circular]");
    if (depth >= MAX_DEPTH) return str("[depth]");
    seen.add(o);
    try {
      if (Array.isArray(o) || o instanceof Set) {
        const items = [...(o as Iterable<unknown>)].map((x) =>
          anyValue(x, depth + 1, seen),
        );
        return `{"arrayValue":{"values":[${items.join(",")}]}}`;
      }
      const entries: [string, unknown][] =
        o instanceof Map
          ? [...o].map(([k, x]) => [String(k), x])
          : Object.keys(o).map((k) => {
              try {
                return [k, (o as Record<string, unknown>)[k]];
              } catch {
                return [k, "[unserialisable]"];
              }
            });
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // the same map always encodes the same way
      const kvs = entries.map(
        ([k, x]) =>
          `{"key":${JSON.stringify(k)},"value":${anyValue(x, depth + 1, seen)}}`,
      );
      return `{"kvlistValue":{"values":[${kvs.join(",")}]}}`;
    } finally {
      seen.delete(o);
    }
  } catch {
    return str("[unserialisable]");
  }
}

/** rfc3339 is Go's time.RFC3339Nano: no trailing zeros in the fraction. */
export function rfc3339(d: Date): string {
  if (Number.isNaN(d.getTime())) return "Invalid Date";
  return d
    .toISOString()
    .replace(/\.?0+Z$/, "Z")
    .replace(/\.Z$/, "Z");
}
