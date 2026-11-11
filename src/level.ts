// The six levels as OpenTelemetry severity numbers (spec SDK-01).
export const LEVELS = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

export type LevelName = keyof typeof LEVELS;

/** parseLevel reads a level name in any case; "warning" is warn. */
export function parseLevel(s: string | undefined): LevelName | undefined {
  const v = s?.trim().toLowerCase();
  if (v === "warning") return "warn";
  return v && v in LEVELS ? (v as LevelName) : undefined;
}
