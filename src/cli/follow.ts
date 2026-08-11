import WebSocket from "ws";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import { EXIT, type ExitCode } from "./exit-codes";
import { entryLines, formatLogEntries, type Colorize } from "./format";

export interface FollowOptions {
  /** Dashboard base URL, e.g. `http://localhost:4000`. */
  baseURL: string;
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
  stderr: (text: string) => void;
  /** Aborting stops following and resolves with exit code 0 (e.g. Ctrl+C). */
  signal?: AbortSignal;
}

/**
 * Streams a service's log lines until the connection ends or the caller aborts.
 *
 * This is the one place the CLI speaks WebSocket rather than the HTTP control
 * API: the dashboard already broadcasts every log line to connected clients, so
 * following is just a matter of listening. The opening `initial_state` frame
 * carries each service's buffered logs, which doubles as the initial tail — so
 * a follow needs no HTTP call at all.
 *
 * `ws` is used rather than a global `WebSocket` because the package supports
 * Node 20.19, where the global is not yet available. It's already a runtime
 * dependency of this package, so it costs nothing extra to install.
 */
export function followLogs(options: FollowOptions): Promise<ExitCode> {
  const {
    baseURL,
    serviceID,
    initialLines,
    logTypes,
    json,
    plain,
    color,
    stdout,
    stderr,
    signal,
  } = options;

  const wsURL = `${baseURL.replace(/^http/, "ws")}/ws`;

  return new Promise<ExitCode>((resolve) => {
    let settled = false;
    let socket: WebSocket;

    const finish = (code: ExitCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // Already closing or never opened — nothing to do.
      }
      resolve(code);
    };

    const onAbort = () => finish(EXIT.OK);

    if (signal?.aborted) {
      resolve(EXIT.OK);
      return;
    }
    signal?.addEventListener("abort", onAbort);

    try {
      socket = new WebSocket(wsURL);
    } catch (err) {
      stderr(
        `dsd: could not connect to ${wsURL} (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
      resolve(EXIT.UNREACHABLE);
      return;
    }

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
      stderr(
        `dsd: could not reach a dashboard at ${baseURL} (${err.message})\n`,
      );
      finish(EXIT.UNREACHABLE);
    });

    socket.on("close", () => {
      // The dashboard went away (it stopped, or the connection dropped). Report
      // it distinctly rather than exiting 0 as though following ended cleanly —
      // a caller tailing logs wants to know the source disappeared.
      if (settled) return;
      stderr("dsd: connection to the dashboard closed.\n");
      finish(EXIT.UNREACHABLE);
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
            stderr(`dsd: No service with id "${serviceID}".\n`);
            finish(EXIT.NO_SERVICE);
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
            timestamp: message.timestamp,
            line: message.line,
            logType: message.logType,
          });
          return;

        case "logs_cleared":
          if (message.serviceID !== serviceID) return;
          if (!json) stderr("dsd: log buffer cleared.\n");
          return;

        case "status_update":
          // Surface lifecycle changes on stderr so stdout stays pure log output,
          // but the follower can still see the service die or come back.
          if (message.serviceID !== serviceID) return;
          if (!json) {
            stderr(
              `dsd: ${serviceID} is now ${message.status}${
                message.errorDetails ? ` (${message.errorDetails})` : ""
              }.\n`,
            );
          }
          return;

        default:
          return;
      }
    });
  });
}
