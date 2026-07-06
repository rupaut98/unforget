import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  target: "node18",
  minify: true,
  clean: true,
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
