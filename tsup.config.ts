import { readFileSync } from "fs";
import { defineConfig } from "tsup";

// Read rather than import: `tsconfig.json` sets `rootDir: "src"`, so
// `package.json` isn't part of the TypeScript program and can't be imported
// from `src/cli`. The version is injected into the CLI bundle instead.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/backend/index.ts",
    // The `dsd` CLI. It imports only `node:` builtins and type-only shared
    // types, so it bundles without pulling `ws` / `mime-types` into its path.
    bin: "src/cli/bin.ts",
  },
  format: ["cjs", "esm"],
  // Types are the library's public surface; the CLI is an executable, so
  // emitting a `bin.d.ts` for it would just be noise.
  dts: { entry: "src/backend/index.ts" },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["mime-types", "ws"],
  define: { __DSD_VERSION__: JSON.stringify(version) },
});
