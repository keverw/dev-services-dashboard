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

/**
 * Logger function type for DevUI
 */
export type DevUILoggerFunction = (
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
}

export interface Service {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  webLinks?: WebLink[];
  process: ChildProcess | null;
  status: "stopped" | "running" | "starting" | "stopping" | "error" | "crashed";
  logs: LogEntry[];
  errorDetails: string | null;
}

export interface DevUIConfig {
  port?: number;
  hostname?: string;
  maxLogLines?: number;
  defaultCwd?: string;
  services: UserServiceConfig[];
  logger?: DevUILoggerFunction;
}

export interface DevUIServer {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
  port: number;
  stop: () => Promise<void>;
}
