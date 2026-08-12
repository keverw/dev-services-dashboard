import WebSocket from "ws";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import { ABORT_REASON, EXIT, type ExitCode } from "./exit-codes";
import { emitError, type ErrorSink } from "./errors";
import { entryLines, formatLogEntries, type Colorize } from "./format";

export interface FollowOptions {
  /** Dashboard base URL, e.g. `http://localhost:4000`. */
  baseURL: string;
  /**
   * Deadline for the WebSocket handshake, in ms; 0 means none. It covers only
   * the connect, not the follow that comes after it, which is unbounded by
   * design. Without it a peer that accepts the TCP connection but never
   * completes the upgrade would hang forever, which is the one failure `logs`
   * shares with every other command and the only one `--timeout` couldn't reach.
   */
  timeoutMs: number;
  serviceID: string;
  /** How many buffered entries to print before switching to live output. */
  initialLines: number;
  /** Restrict to these log types; empty means all. */
  logTypes: Set<LogEntry["logType"]>;
  /** Emit NDJSON (one object per line) instead of formatted text. */
  json: boolean;
  /** Print bare lines with no timestamp prefix. */
  plain: boolean;
  color: Colorize;
  stdout: (text: string) => void;
  /** Notices (a cleared buffer, a status change), which are not failures. */
  stderr: (text: string) => void;
  /**
   * Where the failures go. Separate from `stderr` because these honor `--json`:
   * a follow that can't connect, loses the dashboard, or names a service that
   * doesn't exist has to report it in the same envelope as every other command,
   * or a caller parsing stderr breaks on exactly the errors it can't foresee.
   */
  sink: ErrorSink;
  /**
   * Aborting stops following. Ctrl+C is the documented way to end a follow, so
   * it resolves with exit code 0; an abort whose reason is `ABORT_REASON.SIGTERM`
   * resolves as interrupted instead, so a killed follower doesn't report success.
   */
  signal?: AbortSignal;
}

/**
 * Streams a service's log lines until the connection ends or the caller aborts.
 *
 * This is the one place the CLI speaks WebSocket rather than the HTTP control
 * API: the dashboard already broadcasts every log line to connected clients, so
 * following is just a matter of listening. The opening `initial_state` frame
 * carries each service's buffered logs, which doubles as the initial tail, so
 * a follow needs no HTTP call at all.
 *
 * `ws` is used rather than a global `WebSocket` because the package supports
 * Node 20.19, where the global is not yet available. It's already a runtime
 * dependency of this package, so it costs nothing extra to install.
 */
export function followLogs(options: FollowOptions): Promise<ExitCode> {
  const {
    baseURL,
    timeoutMs,
    serviceID,
    initialLines,
    logTypes,
    json,
    plain,
    color,
    stdout,
    stderr,
    sink,
    signal,
  } = options;

  const wsURL = `${baseURL.replace(/^http/, "ws")}/ws`;

  return new Promise<ExitCode>((resolve) => {
    let settled = false;
    let socket: WebSocket;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: ExitCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      // Cleared on every exit path, not just a successful open: a pending timer
      // would hold the event loop open after the follow has already resolved.
      if (handshakeTimer) clearTimeout(handshakeTimer);
      try {
        socket.close();
      } catch {
        // Already closing or never opened, so nothing to do.
      }
      resolve(code);
    };

    /**
     * A follow that was aborted still did its job, so it exits 0 — that is what
     * Ctrl+C means here, and it's what an embedding caller means by cancelling.
     * A SIGTERM is the exception: the process was terminated, not asked to stop
     * following, so it reports interrupted and `bin.ts` turns that into 143.
     */
    const abortExitCode = (): ExitCode =>
      signal?.reason === ABORT_REASON.SIGTERM ? EXIT.INTERRUPTED : EXIT.OK;

    const onAbort = () => finish(abortExitCode());

    /**
     * Ends the follow, reporting why in whichever format `--json` asked for.
     *
     * The `settled` guard is here rather than only inside `finish`, because the
     * message is written before the exit code is decided and a late failure must
     * not be reported at all. Closing a socket that is still connecting (Ctrl+C
     * during the handshake) makes `ws` emit an `error` afterwards, so without
     * this a follow that ended successfully still printed an `unreachable`
     * error to stderr and exited 0: a caller reading either signal alone gets a
     * different answer, which is the one thing the envelope exists to prevent.
     */
    const fail = (code: ExitCode, errorCode: string, message: string) => {
      if (settled) return;
      finish(emitError(sink, code, errorCode, message));
    };

    if (signal?.aborted) {
      resolve(abortExitCode());
      return;
    }
    signal?.addEventListener("abort", onAbort);

    try {
      socket = new WebSocket(wsURL);
    } catch (err) {
      // There's no socket to close, so this can't go through `finish`/`fail`,
      // but the abort listener still has to come off, like on every other exit
      // path, and the message still goes out in the format that was asked for.
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(
        emitError(
          sink,
          EXIT.UNREACHABLE,
          "unreachable",
          `could not connect to ${wsURL} (${
            err instanceof Error ? err.message : String(err)
          })`,
        ),
      );
      return;
    }

    // Armed after the constructor, so the throwing path above can't leave a
    // timer behind, and disarmed as soon as the upgrade completes: only the
    // handshake is on a deadline, since a follow itself is meant to run forever.
    if (timeoutMs > 0) {
      handshakeTimer = setTimeout(() => {
        fail(
          EXIT.UNREACHABLE,
          "unreachable",
          `Timed out after ${timeoutMs}ms connecting to ${wsURL}`,
        );
      }, timeoutMs);
    }

    socket.on("open", () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    });

    const wanted = (logType: LogEntry["logType"]) =>
      logTypes.size === 0 || logTypes.has(logType);

    const emit = (entry: LogEntry) => {
      if (!wanted(entry.logType)) return;

      if (json) {
        // NDJSON: one object per line, so a consumer can read the stream
        // incrementally rather than waiting for a document that never ends.
        stdout(`${JSON.stringify(entry)}\n`);
        return;
      }

      stdout(
        plain
          ? `${entryLines(entry).join("\n")}\n`
          : `${formatLogEntries([entry], color)}\n`,
      );
    };

    socket.on("error", (err: Error) => {
      fail(
        EXIT.UNREACHABLE,
        "unreachable",
        `could not reach a dashboard at ${baseURL} (${err.message})`,
      );
    });

    socket.on("close", () => {
      // The dashboard went away (it stopped, or the connection dropped). Report
      // it distinctly rather than exiting 0 as though following ended cleanly:
      // a caller tailing logs wants to know the source disappeared. A close we
      // asked for ourselves is already filtered by `fail`, since `finish` closed
      // the socket only after settling.
      fail(
        EXIT.UNREACHABLE,
        "unreachable",
        "connection to the dashboard closed.",
      );
    });

    socket.on("message", (data: Buffer) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return; // Ignore a frame we can't parse rather than tearing down.
      }

      switch (message.type) {
        case "initial_state": {
          const service = message.services.find((s) => s.id === serviceID);
          if (!service) {
            // Same `service_not_found` code the HTTP routes use for this, so a
            // caller branching on the envelope doesn't need a follow-only case.
            fail(
              EXIT.NO_SERVICE,
              "service_not_found",
              `No service with id "${serviceID}".`,
            );
            return;
          }

          const matching = service.logs.filter((e) => wanted(e.logType));
          const tail =
            initialLines >= matching.length
              ? matching
              : matching.slice(matching.length - initialLines);
          for (const entry of tail) emit(entry);
          return;
        }

        case "log":
          if (message.serviceID !== serviceID) return;
          emit({
            seq: message.seq,
            timestamp: message.timestamp,
            line: message.line,
            logType: message.logType,
          });
          return;

        case "logs_cleared":
          if (message.serviceID !== serviceID) return;
          stderr("dsd: log buffer cleared.\n");
          return;

        case "status_update":
          // Surface lifecycle changes on stderr so stdout stays pure log output,
          // but the follower can still see the service die or come back. Emitted
          // under `--json` too: these only ever go to stderr, so stdout stays
          // valid NDJSON either way, and suppressing them would leave the very
          // callers that pass `--json` (scripts, agents) unable to tell that the
          // service they're following crashed.
          if (message.serviceID !== serviceID) return;
          stderr(
            `dsd: ${serviceID} is now ${message.status}${
              message.errorDetails ? ` (${message.errorDetails})` : ""
            }.\n`,
          );
          return;

        default:
          return;
      }
    });
  });
}
