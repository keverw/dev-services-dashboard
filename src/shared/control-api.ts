/**
 * Wire types for the HTTP control API (`/api/v1/*`).
 *
 * A sibling of `protocol.ts` rather than part of it: `protocol.ts` describes the
 * WebSocket/HTTP surface the built-in React UI speaks, while this describes the
 * REST surface the CLI (and any external tool or agent driving the dashboard
 * with plain `curl`) speaks. Both are imported type-only from the backend and
 * the CLI, so they erase at runtime and tsup inlines them into the published
 * `.d.ts`. Like `protocol.ts`, this file is intentionally dependency-free (no
 * Node or DOM types).
 */

import type {
  LogEntry,
  ServiceSignal,
  ServiceStatusValue,
  WebLink,
} from "./protocol";

/**
 * The public view of a service.
 *
 * Deliberately a subset of the backend's internal `Service`: that object holds a
 * live `ChildProcess` handle (circular, so `JSON.stringify` would throw) and the
 * resolved `env`, which routinely carries secrets. The control API is
 * unauthenticated, so `env`, `cwd`, and `command` are withheld and every
 * response is built through an explicit mapper rather than by serializing a
 * `Service` directly.
 */
export interface ServiceSummary {
  id: string;
  name: string;
  status: ServiceStatusValue;
  errorDetails: string | null;
  /** The running process's pid, or null when nothing is running. */
  pid: number | null;
  webLinks: WebLink[];
  signals: ServiceSignal[];
  dependsOn: string[];
  /** How many entries are currently in this service's log buffer. */
  logCount: number;
  /** Timestamp of the newest buffered log entry, or null when empty. */
  lastLogAt: number | null;
}

/**
 * Machine-readable failure codes. Callers should branch on these rather than on
 * `message`, which is prose and may be reworded.
 */
export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "service_not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "forbidden_origin"
  | "start_failed"
  | "stop_failed"
  | "service_not_running"
  | "start_all_busy"
  | "signal_not_allowed"
  | "shutting_down"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Every `/api/v1` failure response. */
export interface ApiErrorResponse {
  ok: false;
  error: ApiError;
}

export interface HealthResponse {
  ok: true;
  dashboardName: string;
  shuttingDown: boolean;
  serviceCount: number;
  uptimeMs: number;
}

export interface ServiceListResponse {
  ok: true;
  dashboardName: string;
  services: ServiceSummary[];
}

export interface ServiceResponse {
  ok: true;
  service: ServiceSummary;
}

/**
 * The start and restart responses: a `ServiceResponse` plus the flag saying
 * whether the request waited for the outcome. `{wait:false}` answers 202 with
 * `waited:false` and a summary captured before the work ran, so the status in
 * it is the old one; a waited call answers 200 with `waited:true` and a
 * summary taken after. Stop has no such flag, it always waits.
 */
export interface LifecycleResponse extends ServiceResponse {
  waited: boolean;
}

export interface LogsResponse {
  ok: true;
  serviceID: string;
  entries: LogEntry[];
  /** How many entries this response contains. */
  returned: number;
  /** How many entries are in the buffer right now. */
  bufferSize: number;
  /** The configured `maxLogLines` cap. */
  bufferLimit: number;
  /**
   * The `cursor` to send on the next poll **of this service**. Sequence
   * numbers are dashboard-wide, so they order every buffer consistently, but a
   * cursor still belongs to the service it came from: sent to another service
   * it would re-deliver, or skip, that service's own entries.
   *
   * It stops at the last entry in
   * `entries` when `limit` held matching entries back, so the next poll
   * collects the rest; otherwise it is the `seq` of the newest entry in the
   * buffer, since anything newer than the last returned entry was excluded by
   * this request's own `logType` filter and would be excluded again. Falls
   * back to the `cursor` that was sent when there is nothing to point at, and
   * to 0 when neither exists.
   */
  nextCursor: number;
  /**
   * True once lines a poller may never have read are gone for good. That is:
   * the ring buffer has actually evicted an older line (a buffer that has
   * merely reached `bufferLimit` has not evicted anything yet, so this stays
   * false until the next line pushes one out), a `DELETE …/logs` has thrown a
   * non-empty buffer away, or this request's `cursor` predates a restart of
   * the sequence, in which case the buffer is served from the start rather
   * than the cursor.
   */
  truncated: boolean;
}

export interface ClearLogsResponse {
  ok: true;
  serviceID: string;
}

export interface SignalResponse {
  ok: true;
  serviceID: string;
  signal: string;
}

export interface StartAllResponse {
  ok: true;
  started: number;
  failed: number;
  skipped: number;
  total: number;
  services: ServiceSummary[];
}

export interface StopAllResponse {
  ok: true;
  stopped: number;
  failed: number;
  total: number;
  services: ServiceSummary[];
}

/** `GET /api/v1`: a self-describing index, so a `curl`-only client can discover the surface. */
export interface ApiIndexResponse {
  ok: true;
  name: string;
  routes: { method: string; path: string; summary: string }[];
}
