#!/usr/bin/env node
import { run } from "./run";
import { finalExitCode } from "./exit-codes";
import { CLI_VERSION } from "./version";

/**
 * Thin entry point. All behavior lives in `run()` so it can be tested by
 * calling it directly with captured output. See `src/cli/run.test.ts`.
 */

// Ctrl+C ends a long-running command cleanly rather than killing the process
// mid-write. The signal reaches `logs --follow` and any in-flight HTTP request
// (the lifecycle commands run with no client deadline, so a blocking start or a
// stop waiting out a grace period must be interruptible on the first press). A
// second signal exits immediately, so an unresponsive socket can't trap the
// terminal. Either way the process reports the conventional 128 + signal number
// for whichever signal forced it (130 SIGINT, 143 SIGTERM).
const controller = new AbortController();
let signalExitCode: number | undefined;
const onSignal = (code: number) => () => {
  if (signalExitCode !== undefined) process.exit(code);
  signalExitCode = code;
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
  // See `finalExitCode` for why a signalled command doesn't always report the
  // signal's code. (`run` already returns EXIT.INTERRUPTED for a request cut
  // short mid-flight; this covers a signal landing elsewhere.)
  process.exitCode = finalExitCode(code, signalExitCode);
  // Drop the signal handlers so nothing keeps the event loop alive once the
  // command has finished.
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
});
