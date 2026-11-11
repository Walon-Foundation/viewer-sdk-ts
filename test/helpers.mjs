// Shared by the tests. They import the SDK as "#sdk": its source under Bun, and the built
// dist/ under Node, so both runtimes test the same behaviour (plan7 decision 2).
import { createLogger } from "#sdk";

/** capture returns a logger whose console lines land in an array. */
export function capture(options = {}) {
  const lines = [];
  const log = createLogger({
    console: "json",
    ...options,
    write: (l) => lines.push(l),
  });
  return { log, lines, json: () => lines.map((l) => JSON.parse(l)) };
}

/** withEnv runs fn with process.env changed, then puts it back. */
export async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** stderrLines captures what the SDK says on stderr while fn runs. */
export async function stderrLines(fn) {
  const got = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => {
    got.push(String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return got;
}
