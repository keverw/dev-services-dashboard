import { EXIT, type ExitCode } from "./exit-codes";

/**
 * Where a failure goes, and in which format.
 *
 * Its own module rather than a helper inside `run.ts` because `follow.ts` needs
 * it too, and `run.ts` already imports `follow.ts`. One formatter for both is
 * the whole point: `--json` is a contract, and a caller that always parses
 * stderr must not meet a bare sentence on the one path nobody thought about.
 */
export interface ErrorSink {
  stderr: (text: string) => void;
  json: boolean;
}

/**
 * Writes one failure to stderr in whichever format the caller asked for, and
 * returns its exit code so call sites can `return emitError(...)`.
 *
 * The envelope carries the same `exitCode` the process will return, so a script
 * branching on the parsed object and a script branching on `$?` can never
 * disagree.
 */
export function emitError(
  sink: ErrorSink,
  code: ExitCode,
  errorCode: string,
  message: string,
): ExitCode {
  if (sink.json) {
    sink.stderr(
      `${JSON.stringify({
        ok: false,
        error: { code: errorCode, message },
        exitCode: code,
      })}\n`,
    );
  } else {
    sink.stderr(`dsd: ${message}\n`);
  }
  return code;
}

/** A bad invocation: unknown command or flag, missing or surplus argument. */
export function usageError(sink: ErrorSink, message: string): ExitCode {
  return emitError(sink, EXIT.USAGE, "usage", message);
}
