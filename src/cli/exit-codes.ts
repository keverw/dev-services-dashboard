/**
 * Process exit codes.
 *
 * These are the CLI's real contract with a script or an AI agent driving it:
 * the human-readable output may be reworded at any time, but a caller can
 * branch on these. They're deliberately fine-grained where the right reaction
 * differs — "you typed a service name that doesn't exist" (4), "the dashboard
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
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

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
];
