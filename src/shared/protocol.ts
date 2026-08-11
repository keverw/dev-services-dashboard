/**
 * Shared wire protocol between the backend and the React frontend.
 *
 * Both sides import it as `@shared/protocol` (a tsconfig `paths` alias, plus a
 * Vite resolve alias for the frontend). It is intentionally dependency-free (no
 * Node or DOM types) so both toolchains can include it — the backend's imports
 * are type-only, so they erase at runtime and tsup just inlines the types into
 * the published `.d.ts`. It holds only the types that cross the HTTP/WebSocket
 * boundary; runtime-only types (e.g. `Service`, which holds a `ChildProcess`)
 * stay backend-local.
 */

export interface WebLink {
  label: string;
  url: string;
}

export interface ServiceSignal {
  label: string;
  signal: string;
}

/** The lifecycle states a service can be in. */
export type ServiceStatusValue =
  | "stopped"
  | "running"
  | "initializing"
  | "starting"
  | "finalizing"
  | "stopping"
  | "error"
  | "crashed";

export interface LogEntry {
  timestamp: number;
  line: string;
  logType: "stdout" | "stderr" | "system";
}

/** Per-service snapshot the server sends in `initial_state`. */
export interface InitialStateService {
  id: string;
  name: string;
  status: ServiceStatusValue;
  logs: LogEntry[];
  errorDetails: string | null;
  webLinks: WebLink[];
  signals: ServiceSignal[];
  dependsOn: string[];
}

/** Per-service outcome reported during a "Start All" run. */
export type StartAllResult = "starting" | "started" | "failed" | "skipped";
/** Per-service outcome reported during a "Stop All" run. */
export type StopAllResult = "stopped" | "failed";

/**
 * Messages the server broadcasts (or sends) to clients, discriminated on `type`.
 * The backend's broadcast function is typed against this so every message it
 * emits is checked, and the client narrows on `type` to consume them.
 */
export type ServerMessage =
  | { type: "initial_state"; services: InitialStateService[] }
  | {
      type: "log";
      serviceID: string;
      line: string;
      logType: LogEntry["logType"];
      timestamp: number;
    }
  | {
      type: "status_update";
      serviceID: string;
      status: ServiceStatusValue;
      errorDetails: string | null;
    }
  | { type: "links_update"; serviceID: string; webLinks: WebLink[] }
  | { type: "logs_cleared"; serviceID: string }
  | { type: "error_from_server"; message: string }
  | { type: "start_all_begin"; total: number }
  | {
      type: "start_all_progress";
      serviceID: string;
      serviceName: string;
      result: StartAllResult;
      started: number;
      total: number;
      dependencyName?: string;
      errorDetails?: string | null;
    }
  | { type: "start_all_done"; started: number; failed: number; skipped: number }
  | { type: "stop_all_begin"; total: number }
  | {
      type: "stop_all_progress";
      serviceID: string;
      serviceName: string;
      result: StopAllResult;
      stopped: number;
      failed: number;
      total: number;
    }
  | { type: "stop_all_done"; stopped: number; failed: number };

/** Messages the client sends to the server, discriminated on `action`. */
export type ClientMessage =
  | { action: "start_all" }
  | {
      action: "stop_all";
      /** Force-kill every service, including ones already `stopping`. */
      force?: boolean;
      /** Override the grace period for every stop in this run. */
      graceMs?: number;
    }
  | { action: "start" | "clear_logs"; serviceID: string }
  | {
      action: "stop" | "restart";
      serviceID: string;
      /**
       * Skip the graceful phase and SIGKILL the process immediately, instead of
       * SIGTERM followed by the service's `stopTimeout` grace period. Also
       * accepted while the service is already `stopping`, where it cuts short
       * the grace period of the stop already in flight.
       */
      force?: boolean;
      /**
       * Override how long this stop waits before escalating to SIGKILL, instead
       * of the service's configured `stopTimeout`. Non-positive values fall back
       * to the configured value; `force` (no grace period at all) takes
       * precedence over both.
       */
      graceMs?: number;
    }
  | { action: "send_signal"; serviceID: string; signal: string };
