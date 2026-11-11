// @walon-foundation/viewer-sdk-ts: the logger for the Viewer platform.
// Runs on Node >= 20 and Bun >= 1.1, with no runtime dependencies.

export type { RequestMeta } from "./context";
export { LEVELS, type LevelName, parseLevel } from "./level";
export { createLogger, Logger, type RequestScope, SDK_VERSION } from "./logger";
export type {
  FetchOptions,
  MiddlewareOptions,
  NodeMiddleware,
  NodeRequest,
  NodeResponse,
} from "./middleware";
export type { Exporter, LoggerOptions } from "./options";
export type { Attributes, LogRecord } from "./record";
export type { FlushResult, Stats } from "./transport";

export const SDK_NAME = "@walon-foundation/viewer-sdk-ts";
