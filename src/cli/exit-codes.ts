/**
 * Process exit codes.
 *
 * These are the CLI's real contract with a script or an AI agent driving it:
 * the human-readable output may be reworded at any time, but a caller can
 * branch on these. They're deliberately fine-grained where the right reaction
 * differs: "you typed a service name that doesn't exist" (4), "the dashboard
 * isn't running" (5), and "it's mid-shutdown, try again shortly" (6) all mean
 * very different things to whoever is retrying.
 */
export const EXIT = {
  /** The command did what was asked. */
  OK: 0,
  /** An unexpected failure in the CLI itself, or a 500 from the dashboard. */
  INTERNAL: 1,
  /** Bad invocation: unknown command, unknown flag, missing argument. */
  USAGE: 2,
  /**
   * The request was understood but the operation didn't succeed: a service
   * failed to start, a `--check` found something not running, a bulk operation
   * had failures.
   */
  FAILED: 3,
  /** No service with that ID. */
  NO_SERVICE: 4,
  /** Couldn't reach a dashboard at the target URL. */
  UNREACHABLE: 5,
  /** The dashboard is shutting down and refused the action. */
  SHUTTING_DOWN: 6,
  /** The signal isn't declared in the service's `signals` allow-list. */
  SIGNAL_NOT_ALLOWED: 7,
  /** The dashboard answered with something this CLI didn't expect. */
  UNEXPECTED: 8,
  /**
   * The command was cut short by Ctrl+C before it finished, so its outcome is
   * unknown (the dashboard may well have carried on). 130 rather than a number
   * in the sequence above: it's the conventional 128 + SIGINT, which is what a
   * shell reports for an interrupted process anyway.
   *
   * Note `logs --follow` does NOT use this for Ctrl+C. Ctrl+C is how you end a
   * follow, so that finishing normally is a success and still exits 0. It does
   * use it for a SIGTERM, which terminated the process rather than ending the
   * follow, and which `finalExitCode` then reports as 143.
   */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The reason `bin.ts` passes to `AbortController.abort()`, naming the signal
 * that arrived.
 *
 * Only `logs --follow` reads it, and only to tell the two apart: Ctrl+C is the
 * documented way to end a follow, so it finishes successfully, while a SIGTERM
 * from a supervisor is a termination and has to keep reporting 143. Without the
 * reason both look like the same abort and a killed follow claims success.
 */
export const ABORT_REASON = {
  SIGINT: "SIGINT",
  SIGTERM: "SIGTERM",
} as const;

export type AbortReason = (typeof ABORT_REASON)[keyof typeof ABORT_REASON];

/**
 * The process's exit code, given what `run()` returned and the code of a signal
 * that arrived before it finished (if one did).
 *
 * A command that still finished its job keeps its own code even though a signal
 * arrived: Ctrl+C is the documented way to end `logs --follow`, so that is a
 * success, not a 130. Only a command that did NOT complete reports the signal's
 * conventional code.
 *
 * A pure function rather than an inline expression in `bin.ts` because it is the
 * whole of a documented contract (see the exit-code table in the README) and
 * `bin.ts` is otherwise untestable without spawning a process.
 */
export function finalExitCode(code: number, signalExitCode?: number): number {
  // Anything that isn't a real number would become `process.exitCode =
  // undefined`, i.e. a silent exit 0 on a command that failed. Treat it as an
  // internal fault rather than letting a wrong success reach a shell script.
  if (!Number.isInteger(code)) return signalExitCode ?? EXIT.INTERNAL;
  return code === EXIT.OK ? code : (signalExitCode ?? code);
}

/** One-line descriptions, shown in `--help` so the table is self-documenting. */
export const EXIT_DESCRIPTIONS: [number, string][] = [
  [EXIT.OK, "success"],
  [EXIT.INTERNAL, "internal error"],
  [EXIT.USAGE, "usage error"],
  [EXIT.FAILED, "operation failed"],
  [EXIT.NO_SERVICE, "no such service"],
  [EXIT.UNREACHABLE, "dashboard unreachable"],
  [EXIT.SHUTTING_DOWN, "dashboard shutting down"],
  [EXIT.SIGNAL_NOT_ALLOWED, "signal not allowed"],
  [EXIT.UNEXPECTED, "unexpected API response"],
  [EXIT.INTERRUPTED, "interrupted before completing"],
  // Not a member of `EXIT`, since no command ever returns it: the process
  // reports it when a SIGTERM lands, the way any Unix program does. It's
  // documented alongside the rest because `logs --follow` makes it a real
  // distinction (Ctrl+C is a clean finish there, a SIGTERM is not), and an
  // agent reading this table is exactly who needs to know that.
  [143, "terminated by SIGTERM before completing"],
];
