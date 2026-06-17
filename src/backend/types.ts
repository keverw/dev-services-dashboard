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
  /** Replaces the service's web links (pushed live to the dashboard). */
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
  gracefulShutdown?: boolean;
  stopTimeout?: number;
  process: ChildProcess | null;
  status:
    | "stopped"
    | "running"
    | "initializing"
    | "starting"
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
  services: UserServiceConfig[];
  logger?: DevServicesDashboardLoggerFunction;
}

export interface DevUIServer {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
  port: number;
  stop: () => Promise<void>;
}
