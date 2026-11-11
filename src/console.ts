import type { Settings } from "./options";
import { type LogRecord, nanosToDate, plain } from "./record";

// The console (spec D-07, SDK-06): readable text in development, JSON lines in production.

export type ConsoleWriter = (r: LogRecord) => void;

export function consoleWriter(s: Settings): ConsoleWriter | undefined {
  if (s.console === false) return undefined;
  if (s.console === "json") {
    return (r) => s.write(`${jsonLine(r, s.service, s.env)}\n`);
  }
  return (r) => s.write(prettyLine(r));
}

export function jsonLine(r: LogRecord, service: string, env: string): string {
  const out: Record<string, unknown> = {
    time: nanosToDate(r.timeUnixNano).toISOString(),
    level: r.level,
    service,
    env,
    msg: r.message,
  };
  if (r.traceId) {
    out.trace_id = r.traceId;
    out.span_id = r.spanId;
  }
  for (const [k, v] of Object.entries(r.attributes)) out[k] = plain(v);
  return JSON.stringify(out);
}

export function prettyLine(r: LogRecord): string {
  const t = nanosToDate(r.timeUnixNano).toISOString().slice(11, 23);
  const lvl = r.level.toUpperCase().padEnd(6);
  let line = `${t} ${lvl}${r.message}`;
  let stack = "";
  for (const [k, v] of Object.entries(r.attributes)) {
    if (k === "exception.stacktrace") {
      stack = String(v);
      continue;
    }
    line += `  ${k}=${text(v)}`;
  }
  if (r.traceId) line += `  trace_id=${r.traceId}`;
  line += "\n";
  if (stack) {
    for (const l of stack.split("\n"))
      if (l.trim()) line += `    ${l.trim()}\n`;
  }
  return line;
}

function text(v: unknown): string {
  const p = plain(v);
  const s = typeof p === "string" ? p : JSON.stringify(p);
  return s === "" || /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}
