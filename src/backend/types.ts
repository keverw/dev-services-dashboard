import { ChildProcess } from "child_process";
import { type Server as HttpServer } from "http";
import { WebSocketServer } from "ws";

export interface LogEntry {
  timestamp: number;
  line: string;
  logType: "stdout" | "stderr" | "system";
}

export interface WebLink {
  label: string;
  url: string;
}

export interface ServiceSignal {
  label: string;
  signal: string;
}

/**
 * Context passed to a service's `beforeStart` hook. The hook runs after the
 * environment is merged but before the process is spawned.
 */
export interface BeforeStartContext {
  /** Merged env (process.env + service env) that will be passed to the process. */
  env: Record<string, string>;
  /** The service's currently configured web links. */
  webLinks: WebLink[];
  /** Writes a "system" log line to the service's log stream. */
  log: (line: string) => void;
  /** Aborted if the user stops the service while the hook is still running. */
  signal: AbortSignal;
}

/**
 * What a `beforeStart` hook may return to customize the launch. Any field left
 * out keeps its existing value.
 */
export interface BeforeStartResult {
  /** Replaces the env passed to the spawned process. */
  env?: Record<string, string>;
  /**
   * Replaces the service's web links (pushed live to the dashboard). Omit (or
   * return undefined/null) to leave them unchanged; return `[]` to clear them.
   */
  webLinks?: WebLink[];
}

/**
 * Context passed to a service's `afterStart` hook. The hook runs after the
 * process has spawned but before the service is reported `running` — so it acts
 * as a readiness/post-start gate (e.g. wait for the port to accept connections,
 * run a DB migration). Throwing tears the just-started process back down and
 * puts the service into the `error` state.
 */
export interface AfterStartContext {
  /** The env the process was spawned with. */
  env: Record<string, string>;
  /** The spawned process's pid (undefined only if it vanished immediately). */
  pid: number | undefined;
  /**
   * The current live web links (a copy): the links a `beforeStart` on this
   * service returned this run, or the configured baseline if there was none.
   * Build from these (`[...webLinks, x]`) to extend rather than discard them.
   */
  webLinks: WebLink[];
  /** Writes a "system" log line to the service's log stream. */
  log: (line: string) => void;
  /**
   * Aborted if the service is stopped while the hook runs, or if the process
   * exits/crashes on its own under it — so a readiness check that polls the
   * process (e.g. `await waitForPort(port, { signal })`) can give up. Note a
   * hook that throws is still treated as a failed start (`error`) even when the
   * throw was its response to this abort.
   */
  signal: AbortSignal;
}

/**
 * What an `afterStart` hook may return. Any field left out keeps its value.
 */
export interface AfterStartResult {
  /**
   * Replaces the service's live web links (pushed live to the dashboard).
   * Returning `[...webLinks, x]` (from the context's current links) keeps any
   * a `beforeStart` already added; returning a fresh array discards them. Omit
   * (or return undefined/null) to leave them unchanged; return `[]` to clear.
   */
  webLinks?: WebLink[];
}

/**
 * Logger function type for DevUI
 */
export type DevServicesDashboardLoggerFunction = (
  type: "info" | "error" | "warn",
  message: string,
  data?: object,
) => void;

export interface UserServiceConfig {
  id: string;
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  webLinks?: WebLink[];
  signals?: ServiceSignal[];
  dependsOn?: string[];
  beforeStart?: (ctx: BeforeStartContext) => Promise<BeforeStartResult | void>;
  /**
   * Runs after the process has spawned but before the service is reported
   * `running`. Use it as a readiness gate or post-start step (wait for a port,
   * run a migration). Throwing tears the process back down and marks the service
   * `error`; "Start All" waits for it to resolve before starting dependents.
   */
  afterStart?: (ctx: AfterStartContext) => Promise<AfterStartResult | void>;
  /**
   * When true, the graceful stop signal (SIGTERM) is sent to only the main
   * process instead of the whole process group, letting the process coordinate
   * shutting down its own children (e.g. to test graceful shutdown / signal
   * forwarding). The forced SIGKILL still targets the whole group as a safety
   * net so nothing is orphaned. Default: false (signal the whole group).
   */
  gracefulShutdown?: boolean;
  /**
   * How long (ms) to wait after SIGTERM before escalating to SIGKILL on stop.
   * Overrides the global `stopTimeout`. Default: 5000.
   */
  stopTimeout?: number;
}

export interface Service {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  /** The configured web links (immutable baseline passed to `beforeStart`). */
  webLinks?: WebLink[];
  /**
   * Web links set by the last `beforeStart` run, overriding `webLinks` for
   * display. Kept separate so the hook always receives the configured baseline
   * and additive patterns (`[...webLinks, x]`) don't accumulate across restarts.
   */
  liveWebLinks?: WebLink[];
  signals?: ServiceSignal[];
  dependsOn?: string[];
  beforeStart?: (ctx: BeforeStartContext) => Promise<BeforeStartResult | void>;
  afterStart?: (ctx: AfterStartContext) => Promise<AfterStartResult | void>;
  gracefulShutdown?: boolean;
  stopTimeout?: number;
  process: ChildProcess | null;
  status:
    | "stopped"
    | "running"
    | "initializing"
    | "starting"
    | "finalizing"
    | "stopping"
    | "error"
    | "crashed";
  logs: LogEntry[];
  errorDetails: string | null;
}

export interface DevUIConfig {
  port?: number;
  hostname?: string;
  maxLogLines?: number;
  defaultCwd?: string;
  dashboardName?: string;
  /**
   * Default time (ms) to wait after SIGTERM before escalating to SIGKILL when
   * stopping a service. Per-service `stopTimeout` overrides this. Default: 5000.
   */
  stopTimeout?: number;
  /**
   * How long (ms) "Start All" waits for a service to report `running` after it
   * begins spawning before treating it as timed out. Default: 10000.
   */
  startTimeout?: number;
  /**
   * How long (ms) "Start All" waits during a service's `beforeStart`
   * (`initializing`) phase before treating it as a failed start: the hook is
   * aborted and the service is put into `error` (its dependents are skipped).
   * Default: 60000.
   */
  beforeStartTimeout?: number;
  /**
   * How long (ms) "Start All" waits during a service's `afterStart`
   * (`finalizing`) phase before treating it as a failed start: the hook is
   * aborted, the started process is torn down, and the service is put into
   * `error` (its dependents are skipped). Default: 60000.
   */
  afterStartTimeout?: number;
  services: UserServiceConfig[];
  logger?: DevServicesDashboardLoggerFunction;
}

export interface DevUIServer {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
  port: number;
  stop: () => Promise<void>;
}
