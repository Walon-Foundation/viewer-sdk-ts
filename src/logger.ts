import { type ConsoleWriter, consoleWriter } from "./console";
import { LEVELS, type LevelName } from "./level";
import { type LoggerOptions, resolveOptions, type Settings } from "./options";
import {
  type Attributes,
  type LogRecord,
  nowNanos,
  withException,
} from "./record";

/** What a request adds to every record logged inside it (set by runWithRequest). */
export interface RequestScope {
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
}

/** The parts every child of one logger shares. */
export class Core {
  readonly settings: Settings;
  readonly console: ConsoleWriter | undefined;
  /** Hands a record on to the transport; replaced in step 7.2. */
  ship: (r: LogRecord) => void = () => {};
  logged = 0;
  /** Supplies the current request's scope; replaced in step 7.3. */
  scope: () => RequestScope | undefined = () => undefined;

  constructor(settings: Settings) {
    this.settings = settings;
    this.console = consoleWriter(settings);
  }
}

let warnedPanic = false;

export function stderr(line: string): void {
  const err = (
    globalThis as { process?: { stderr?: { write(s: string): unknown } } }
  ).process?.stderr;
  if (err) err.write(`${line}\n`);
  else console.error(line);
}

/**
 * Logger writes structured records. Every method returns at once and never throws: logging
 * must not take the program down (spec SDK-04).
 */
export class Logger {
  readonly #core: Core;
  readonly #attrs: Attributes;

  /** @internal use createLogger */
  constructor(core: Core, attrs: Attributes = {}) {
    this.#core = core;
    this.#attrs = attrs;
  }

  /** @internal */
  get core(): Core {
    return this.#core;
  }

  trace(msg: string, attrs?: Attributes): void {
    this.log("trace", msg, attrs);
  }
  debug(msg: string, attrs?: Attributes): void {
    this.log("debug", msg, attrs);
  }
  info(msg: string, attrs?: Attributes): void {
    this.log("info", msg, attrs);
  }
  warn(msg: string, attrs?: Attributes): void {
    this.log("warn", msg, attrs);
  }
  error(msg: string, attrs?: Attributes): void {
    this.log("error", msg, attrs);
  }
  /** fatal records at the fatal level. It does not exit the process. */
  fatal(msg: string, attrs?: Attributes): void {
    this.log("fatal", msg, attrs);
  }

  /** child returns a logger that adds attrs to every record (spec SDK-02). */
  child(attrs: Attributes): Logger {
    return new Logger(this.#core, { ...this.#attrs, ...asAttrs(attrs) });
  }

  isEnabled(level: LevelName): boolean {
    return LEVELS[level] >= LEVELS[this.#core.settings.level];
  }

  log(level: LevelName, msg: string, attrs?: Attributes): void {
    if (!this.isEnabled(level)) return;
    try {
      const c = this.#core;
      const scope = c.scope();
      const merged = withException({
        ...scope?.attributes,
        ...this.#attrs,
        ...asAttrs(attrs),
      });
      const r: LogRecord = {
        timeUnixNano: nowNanos(),
        level,
        message: typeof msg === "string" ? msg : String(msg),
        attributes: merged,
      };
      if (scope?.traceId) {
        r.traceId = scope.traceId;
        r.spanId = scope.spanId;
      }
      c.logged++;
      c.console?.(r);
      c.ship(r);
    } catch (e) {
      if (!warnedPanic) {
        warnedPanic = true;
        stderr(
          `viewer: a log call failed and was dropped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

function asAttrs(a: unknown): Attributes {
  if (a === undefined || a === null) return {};
  if (typeof a === "object" && !Array.isArray(a) && !(a instanceof Error))
    return a as Attributes;
  return a instanceof Error ? { err: a } : { value: a };
}

/** createLogger never throws: a missing or broken setting falls back to the console only (SDK-08). */
export function createLogger(options?: LoggerOptions): Logger {
  const s = resolveOptions(options);
  for (const p of s.problems)
    stderr(`viewer: ${p}; logging to the console only`);
  return new Logger(new Core(s));
}
