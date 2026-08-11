#!/usr/bin/env node
import { run } from "./run";
import { CLI_VERSION } from "./version";

/**
 * Thin entry point. All behavior lives in `run()` so it can be tested by
 * calling it directly with captured output — see `src/cli/run.test.ts`.
 */

// Ctrl+C ends a long-running command (`logs --follow`) cleanly rather than
// killing the process mid-write. A second signal exits immediately, so an
// unresponsive socket can't trap the terminal — reporting the conventional
// 128 + signal number for whichever signal forced it (130 SIGINT, 143 SIGTERM).
const controller = new AbortController();
let interrupted = false;
const onSignal = (code: number) => () => {
  if (interrupted) process.exit(code);
  interrupted = true;
  controller.abort();
};
const onInterrupt = onSignal(130);
const onTerminate = onSignal(143);
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

void run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  version: CLI_VERSION,
  signal: controller.signal,
}).then((code) => {
  process.exitCode = code;
  // Drop the signal handlers so nothing keeps the event loop alive once the
  // command has finished.
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
});
