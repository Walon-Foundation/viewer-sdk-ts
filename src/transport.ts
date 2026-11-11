import { hostname } from "node:os";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { encodeRequest } from "./encode";
import type { Exporter, Settings } from "./options";
import { type Attributes, type LogRecord, nowNanos } from "./record";

const gzip = promisify(gzipCb);

/** Stats counts what happened to records (spec SDK-04): nothing is lost without a count. */
export interface Stats {
  /** Log calls at or above the level. */
  logged: number;
  /** Waiting to be sent now. */
  queued: number;
  /** Accepted by the server or the exporter. */
  sent: number;
  /** Dropped, by reason: the oldest made way for a newer one … */
  queueFull: number;
  /** … the server refused it (partial success, or a 4xx) … */
  rejected: number;
  /** … still unsent after the retries, or at shutdown … */
  failed: number;
  /** … or logged after shutdown (written to the console only). */
  afterShutdown: number;
}

/** FlushResult says what was left when flush or shutdown returned. */
export interface FlushResult {
  unsent: number;
  timedOut: boolean;
}

const MAX_TRIES = 5;
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** A refusal retrying won't fix. */
class Refused extends Error {}
/** A failure worth trying again, with the server's requested wait. */
class Retry extends Error {
  constructor(
    message: string,
    readonly afterMs = 0,
  ) {
    super(message);
  }
}

type Send = (batch: LogRecord[]) => Promise<number>; // resolves with how many were refused

export class Transport {
  readonly #s: Settings;
  readonly #send: Send;
  #buf: LogRecord[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #warnedKey = false;
  readonly stats = {
    sent: 0,
    queueFull: 0,
    rejected: 0,
    failed: 0,
    afterShutdown: 0,
  };
  #reported = { queueFull: 0, rejected: 0, failed: 0, at: new Date() };
  /** Replaced by tests, so retries don't really wait. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms));
  /** Replaced by tests to observe the waits. */
  jitter: () => number = Math.random;
  readonly #version: string;

  constructor(s: Settings, version: string, stderr: (l: string) => void) {
    this.#s = s;
    this.#version = version;
    this.#send = s.exporter ? exporterSend(s.exporter) : this.#httpSend(stderr);
    this.#timer = setInterval(() => this.#kick(), s.flushIntervalMs);
    unref(this.#timer);
  }

  get queued(): number {
    return this.#buf.length;
  }

  /** push queues a record without waiting. A full queue drops its oldest (SDK-04). */
  push(r: LogRecord): void {
    if (this.#closed) {
      this.stats.afterShutdown++;
      return;
    }
    if (this.#buf.length >= this.#s.queueSize) {
      this.#buf.shift();
      this.stats.queueFull++;
    }
    this.#buf.push(r);
    if (this.#buf.length >= this.#s.batchSize) this.#kick();
  }

  /** kick starts the one drain loop if it isn't running. Only one request is in flight. */
  #kick(): Promise<void> {
    if (!this.#running && this.#buf.length > 0) {
      this.#running = this.#drain().finally(() => {
        this.#running = undefined;
      });
    }
    return this.#running ?? Promise.resolve();
  }

  async #drain(): Promise<void> {
    while (this.#buf.length > 0) {
      const batch = this.#buf.splice(0, this.#s.batchSize);
      await this.#deliver(batch);
    }
  }

  async #deliver(batch: LogRecord[]): Promise<void> {
    const n = batch.length;
    const { queueFull, rejected, failed } = this.stats;
    const r = this.#reported;
    const report =
      queueFull > r.queueFull || rejected > r.rejected || failed > r.failed;
    const out = report ? [...batch, this.#dropReport()] : batch;
    let err: unknown;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        const refused = Math.min(await this.#send(out), n); // the report isn't a user record
        this.stats.sent += n - refused;
        this.stats.rejected += refused;
        if (report)
          this.#reported = { queueFull, rejected, failed, at: new Date() };
        return;
      } catch (e) {
        err = e;
        if (!(e instanceof Retry) || attempt === MAX_TRIES - 1) break;
        const wait =
          e.afterMs > 0
            ? Math.min(e.afterMs, MAX_RETRY_AFTER_MS)
            : backoff(attempt, this.jitter());
        await this.sleep(wait);
      }
    }
    if (err instanceof Refused) this.stats.rejected += n;
    else this.stats.failed += n;
  }

  #dropReport(): LogRecord {
    const r = this.#reported;
    const q = this.stats.queueFull - r.queueFull;
    const x = this.stats.rejected - r.rejected;
    const f = this.stats.failed - r.failed;
    return {
      timeUnixNano: nowNanos(),
      level: "warn",
      message: `viewer-sdk: dropped ${q + x + f} records since ${r.at.toISOString().replace(/\.\d+Z$/, "Z")}`,
      attributes: {
        "viewer.dropped.queue_full": q,
        "viewer.dropped.rejected": x,
        "viewer.dropped.failed": f,
      },
    };
  }

  /** flush sends what is queued, waiting at most timeoutMs (spec SDK-05). */
  async flush(timeoutMs = 5_000): Promise<FlushResult> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((r) => {
      timer = setTimeout(() => {
        timedOut = true;
        r();
      }, timeoutMs);
      unref(timer);
    });
    const work = (async () => {
      while (!timedOut && (this.#running || this.#buf.length > 0))
        await this.#kick();
    })();
    await Promise.race([work, deadline]);
    clearTimeout(timer);
    return { unsent: this.#buf.length, timedOut };
  }

  /** shutdown flushes, then stops. What is left counts as failed. */
  async shutdown(timeoutMs = 5_000): Promise<FlushResult> {
    clearInterval(this.#timer);
    const res = await this.flush(timeoutMs);
    this.#closed = true;
    if (this.#buf.length > 0) {
      this.stats.failed += this.#buf.length;
      this.#buf = [];
    }
    return res;
  }

  #httpSend(stderr: (l: string) => void): Send {
    const s = this.#s;
    const resource = resourceOf(s, this.#version);
    return async (batch) => {
      const body = await gzip(
        encodeRequest(resource, batch, nowNanos(), this.#version),
      );
      let res: Response;
      try {
        res = await fetch(s.endpoint as string, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            Authorization: `Bearer ${s.apiKey}`,
            "User-Agent": `viewer-sdk-ts/${this.#version}`,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        throw new Retry(e instanceof Error ? e.message : String(e));
      }
      const text = await res.text().catch(() => "");
      if (res.status === 200) return rejectedIn(text);
      if ([429, 502, 503, 504].includes(res.status)) {
        throw new Retry(
          `server answered ${res.status}`,
          retryAfterMs(res.headers.get("retry-after")),
        );
      }
      if ((res.status === 401 || res.status === 403) && !this.#warnedKey) {
        this.#warnedKey = true;
        stderr(
          `viewer: the server refused the API key (${res.status}); check VIEWER_API_KEY`,
        );
      }
      throw new Refused(`server refused the batch: ${res.status}`);
    };
  }
}

function exporterSend(e: Exporter): Send {
  // A local exporter's failures are counted, not retried.
  return async (batch) => {
    await e.export(batch);
    return 0;
  };
}

function resourceOf(s: Settings, version: string): Attributes {
  const p = (globalThis as { process?: { versions?: Record<string, string> } })
    .process;
  const bun = p?.versions?.bun;
  const res: Attributes = {
    "service.name": s.service,
    "deployment.environment.name": s.env,
    "telemetry.sdk.name": SCOPE,
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.version": version,
    "process.runtime.name": bun ? "bun" : "nodejs",
    "process.runtime.version": bun ?? p?.versions?.node ?? "unknown",
  };
  try {
    res["host.name"] = hostname();
  } catch {
    // no host name to give
  }
  return { ...res, ...s.resource };
}

const SCOPE = "viewer-sdk-ts";

/** backoff is 0.5 s, 1 s, 2 s, 4 s … with ±20 % jitter. */
export function backoff(attempt: number, rand: number): number {
  return 500 * 2 ** attempt * (0.8 + 0.4 * rand);
}

/** retryAfterMs reads seconds or an HTTP date. */
export function retryAfterMs(
  h: string | null,
  now: number = Date.now(),
): number {
  if (!h) return 0;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? 0 : Math.max(t - now, 0);
}

/** rejectedIn reads partialSuccess.rejectedLogRecords, a string or a number. */
export function rejectedIn(body: string): number {
  if (!body) return 0;
  try {
    const n = Number(JSON.parse(body)?.partialSuccess?.rejectedLogRecords ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function unref(t: unknown): void {
  (t as { unref?: () => void })?.unref?.();
}
