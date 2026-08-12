/**
 * The CLI's version string.
 *
 * `package.json` can't simply be imported here: `tsconfig.json` sets
 * `rootDir: "src"`, so a file above it isn't part of the program. Instead tsup
 * replaces `__DSD_VERSION__` with the real version at build time (see
 * `tsup.config.ts`). Running straight from source (`bun src/cli/bin.ts`)
 * leaves the identifier undeclared, which `typeof` handles safely, so dev runs
 * report `0.0.0-dev` instead of crashing.
 */
declare const __DSD_VERSION__: string;

export const CLI_VERSION: string =
  typeof __DSD_VERSION__ === "string" ? __DSD_VERSION__ : "0.0.0-dev";
