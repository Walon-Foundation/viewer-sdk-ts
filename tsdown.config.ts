import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/internal.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node20",
  dts: true,
  clean: true,
});
