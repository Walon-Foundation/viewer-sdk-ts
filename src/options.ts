import { type LevelName, parseLevel } from "./level";
import type { LogRecord } from "./record";

/** An exporter replaces the HTTP transport: for tests, or a custom sink. */
export interface Exporter {
  export(records: LogRecord[]): Promise<void>;
}

export interface LoggerOptions {
  /** The OTLP logs URL, e.g. https://viewer.example.org/v1/logs. Env: VIEWER_ENDPOINT. */
  endpoint?: string;
  /** The project's API key. Env: VIEWER_API_KEY. */
  apiKey?: string;
  /** Env: VIEWER_SERVICE. Default "unknown_service", as OpenTelemetry names it. */
  service?: string;
  /** Env: VIEWER_ENV, then NODE_ENV. Default "development". */
  env?: string;
  /** The lowest level recorded. Env: VIEWER_LEVEL. Default "info". */
  level?: LevelName;
  /** "auto" (default): pretty in development, JSON lines in production. false turns it off. */
  console?: "auto" | "pretty" | "json" | false;
  /** Bounded queue, batch size and flush interval (spec SDK-03). */
  queueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Extra resource attributes sent with every batch. */
  resource?: Record<string, unknown>;
  exporter?: Exporter;
  /**
   * Flush on SIGINT/SIGTERM, then let the signal end the process as it would have.
   * Off by default: a listener added behind the app's back changes how Node exits.
   */
  handleSignals?: boolean;
  /** Where console lines go. Default: process.stdout. */
  write?: (line: string) => void;
}

export interface Settings {
  endpoint?: string;
  apiKey?: string;
  service: string;
  env: string;
  level: LevelName;
  console: "pretty" | "json" | false;
  queueSize: number;
  batchSize: number;
  flushIntervalMs: number;
  resource: Record<string, unknown>;
  exporter?: Exporter;
  handleSignals: boolean;
  write: (line: string) => void;
  /** Said once on stderr; none of them stop the logger. */
  problems: string[];
}

export type Env = Record<string, string | undefined>;

export function processEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}

const first = (...vals: (string | undefined)[]): string | undefined => {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
};

const positive = (v: number | undefined, def: number): number =>
  v !== undefined && Number.isFinite(v) && v > 0 ? Math.floor(v) : def;

function stdoutWrite(line: string): void {
  const out = (
    globalThis as { process?: { stdout?: { write(s: string): unknown } } }
  ).process?.stdout;
  if (out) out.write(line);
  else console.log(line.replace(/\n$/, ""));
}

export function resolveOptions(
  o: LoggerOptions = {},
  env: Env = processEnv(),
): Settings {
  const problems: string[] = [];
  const s: Settings = {
    endpoint: first(o.endpoint, env.VIEWER_ENDPOINT),
    apiKey: first(o.apiKey, env.VIEWER_API_KEY),
    service: first(o.service, env.VIEWER_SERVICE) ?? "unknown_service",
    env: first(o.env, env.VIEWER_ENV, env.NODE_ENV) ?? "development",
    level: o.level ?? "info",
    console: "pretty",
    queueSize: positive(o.queueSize, 10_000),
    batchSize: positive(o.batchSize, 500),
    flushIntervalMs: positive(o.flushIntervalMs, 1_000),
    resource: o.resource ?? {},
    exporter: o.exporter,
    handleSignals: o.handleSignals ?? false,
    write: o.write ?? stdoutWrite,
    problems,
  };
  if (!o.level && env.VIEWER_LEVEL) {
    const l = parseLevel(env.VIEWER_LEVEL);
    if (l) s.level = l;
    else
      problems.push(
        `VIEWER_LEVEL "${env.VIEWER_LEVEL}" is not a level; using info`,
      );
  }
  const mode = o.console ?? "auto";
  if (mode === false) s.console = false;
  else if (mode === "auto")
    s.console = /^prod(uction)?$/i.test(s.env) ? "json" : "pretty";
  else s.console = mode;
  let badEndpoint = false;
  if (s.endpoint) {
    const u = normalizeEndpoint(s.endpoint);
    if (u) s.endpoint = u;
    else {
      problems.push(`endpoint "${s.endpoint}" is not an http(s) URL`);
      s.endpoint = undefined;
      badEndpoint = true;
    }
  }
  // Half a configuration is a mistake worth saying; none at all is local development.
  if (!s.exporter && !badEndpoint) {
    if (s.endpoint && !s.apiKey)
      problems.push("an endpoint is set but no API key (VIEWER_API_KEY)");
    if (!s.endpoint && s.apiKey)
      problems.push("an API key is set but no endpoint (VIEWER_ENDPOINT)");
  }
  return s;
}

/** remote says whether records leave the process. */
export function remote(s: Settings): boolean {
  return Boolean(s.exporter || (s.endpoint && s.apiKey));
}

/** normalizeEndpoint accepts the full logs URL or the server's base URL. */
export function normalizeEndpoint(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname)
    return undefined;
  if (!u.pathname.endsWith("/v1/logs"))
    u.pathname = `${u.pathname.replace(/\/$/, "")}/v1/logs`;
  return u.toString();
}
