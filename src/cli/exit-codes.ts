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
   * Note `logs --follow` does NOT use this. Ctrl+C is how you end a follow, so
   * that finishing normally is a success and still exits 0.
   */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

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
];
