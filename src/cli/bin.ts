#!/usr/bin/env node
import { run } from "./run";
import { CLI_VERSION } from "./version";

/**
 * Thin entry point. All behavior lives in `run()` so it can be tested by
 * calling it directly with captured output — see `src/cli/run.test.ts`.
 */
void run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  version: CLI_VERSION,
}).then((code) => {
  process.exitCode = code;
});
