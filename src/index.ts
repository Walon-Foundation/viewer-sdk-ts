// @walon-foundation/viewer-sdk-ts: the logger for the Viewer platform.
// Runs on Node >= 20 and Bun >= 1.1, with no runtime dependencies.

export { LEVELS, type LevelName, parseLevel } from "./level";
export { createLogger, Logger, type RequestScope } from "./logger";
export type { Exporter, LoggerOptions } from "./options";
export type { Attributes, LogRecord } from "./record";

export const SDK_NAME = "@walon-foundation/viewer-sdk-ts";
export const SDK_VERSION = "0.1.0";
