import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    internal: "src/internal.ts",
    hono: "src/adapters/hono.ts",
    express: "src/adapters/express.ts",
    fastify: "src/adapters/fastify.ts",
    elysia: "src/adapters/elysia.ts",
  },
  // Built-ins and the frameworks are the user's: never bundled.
  deps: { neverBundle: [/^node:/, /^hono/, "express", "fastify", "elysia"] },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node20",
  dts: true,
  clean: true,
});
