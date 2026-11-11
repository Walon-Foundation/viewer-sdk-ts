import type { LevelName } from "./level";

export type Attributes = Record<string, unknown>;

/** LogRecord is one log call, as it is queued and exported. */
export interface LogRecord {
  /** Nanoseconds since the epoch, as a decimal string (OTLP's int64 as JSON). */
  timeUnixNano: string;
  level: LevelName;
  message: string;
  /** Bound attributes, then the request's, then the call's; exception fields added. */
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
}

const perf = (
  globalThis as { performance?: { timeOrigin: number; now(): number } }
).performance;

/** nowNanos is the time with the sub-millisecond part kept, without float overflow. */
export function nowNanos(): string {
  const ms = perf ? perf.timeOrigin + perf.now() : Date.now();
  const whole = Math.floor(ms);
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(Math.round((ms - whole) * 1e6))
  ).toString();
}

export function nanosToDate(ns: string): Date {
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

const MAX_CAUSES = 3;

/**
 * withException adds the OpenTelemetry exception fields for the first Error among the
 * attributes (spec SDK-07), and a short cause chain.
 */
export function withException(attrs: Attributes): Attributes {
  for (const v of Object.values(attrs)) {
    if (!(v instanceof Error)) continue;
    const out: Attributes = {
      ...attrs,
      "exception.type": v.name || v.constructor?.name || "Error",
      "exception.message": v.message,
    };
    if (v.stack) out["exception.stacktrace"] = v.stack;
    const causes: string[] = [];
    let c: unknown = (v as { cause?: unknown }).cause;
    while (c !== undefined && causes.length < MAX_CAUSES) {
      causes.push(c instanceof Error ? `${c.name}: ${c.message}` : String(c));
      c = c instanceof Error ? (c as { cause?: unknown }).cause : undefined;
    }
    if (causes.length) out["exception.cause"] = causes.join(" ← ");
    return out;
  }
  return attrs;
}

const MAX_DEPTH = 5;

/**
 * plain turns any value into something JSON can hold: circular references, deep nesting,
 * bigints, dates, bytes, errors and throwing getters all have a fixed form. It never throws.
 */
export function plain(
  v: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  try {
    switch (typeof v) {
      case "string":
      case "boolean":
        return v;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "bigint":
        return v.toString();
      case "undefined":
        return null;
      case "function":
        return `[function ${(v as { name?: string }).name || "anonymous"}]`;
      case "symbol":
        return v.toString();
    }
    if (v === null) return null;
    if (v instanceof Date)
      return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof Error) return v.message;
    if (v instanceof Uint8Array) return toBase64(v);
    const o = v as object;
    if (seen.has(o)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[depth]";
    seen.add(o);
    try {
      if (Array.isArray(o)) return o.map((x) => plain(x, depth + 1, seen));
      if (o instanceof Map) {
        const out: Attributes = {};
        for (const [k, x] of o) out[String(k)] = plain(x, depth + 1, seen);
        return out;
      }
      if (o instanceof Set) return [...o].map((x) => plain(x, depth + 1, seen));
      const out: Attributes = {};
      for (const k of Object.keys(o)) {
        let x: unknown;
        try {
          x = (o as Record<string, unknown>)[k];
        } catch {
          x = "[unserialisable]";
        }
        out[k] = plain(x, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(o);
    }
  } catch {
    return "[unserialisable]";
  }
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}
