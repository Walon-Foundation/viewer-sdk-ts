// Run as a child process: logs once with an exporter and returns without calling shutdown.
// The process must still exit on its own (the timer is unref'd) after beforeExit flushes.
import { createLogger } from "#sdk";

const log = createLogger({
  console: false,
  exporter: { export: async (rs) => console.log(`exported ${rs.length}`) },
  flushIntervalMs: 60_000,
});
log.info("before exit");
