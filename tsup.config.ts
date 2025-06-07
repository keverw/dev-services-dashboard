import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/backend/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["get-port", "mime-types", "ws"],
});
