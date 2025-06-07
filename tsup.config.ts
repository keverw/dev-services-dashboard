import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/backend/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    // Add any external dependencies here if needed
  ],
});
