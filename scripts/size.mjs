// The size budget (plan7 6), minified and gzipped. The core is measured with everything it
// pulls in; an adapter by its own built file, since the chunks it imports are the core's.
// Run after the build.
import { gzipSync } from "node:zlib";

const budget = {
  index: 12 * 1024,
  hono: 1024,
  express: 1024,
  fastify: 1024,
  elysia: 1024,
};
const external = ["node:*", "hono", "hono/*", "express", "fastify", "elysia"];
let failed = false;
const minified = {};
for (const name of Object.keys(budget)) {
  const core = name === "index";
  const out = await Bun.build({
    entrypoints: [core ? "src/index.ts" : `dist/${name}.js`],
    minify: true,
    target: "node",
    external: core ? external : [...external, "./*"],
  });
  if (!out.success) throw new Error(out.logs.join("\n"));
  minified[name] = gzipSync(Buffer.from(await out.outputs[0].text())).length;
}
for (const [name, size] of Object.entries(minified)) {
  const own = size;
  const ok = own <= budget[name];
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "OVER"} ${name.padEnd(8)} ${(own / 1024).toFixed(2)} kB (budget ${(budget[name] / 1024).toFixed(0)} kB)`,
  );
}
process.exit(failed ? 1 : 0);
