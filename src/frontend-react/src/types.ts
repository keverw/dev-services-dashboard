export interface ServiceConfig {
  id: string;
  name: string;
  webLinks?: WebLink[];
  signals?: ServiceSignal[];
  dependsOn?: string[];
}

export interface WebLink {
  label: string;
  url: string;
}

export interface ServiceSignal {
  label: string;
  signal: string;
}

export interface LogEntry {
  line: string;
  logType: "stdout" | "stderr" | "system";
  timestamp: number;
}

export interface ServiceStatus {
  id: string;
  status:
    | "stopped"
    | "running"
    | "initializing"
    | "starting"
    | "finalizing"
    | "stopping"
    | "error"
    | "crashed";
  errorDetails?: string;
}

export interface WebSocketMessage {
  type:
    | "initial_state"
    | "log"
    | "status_update"
    | "logs_cleared"
    | "links_update"
    | "start_all_begin"
    | "start_all_progress"
    | "start_all_done"
    | "stop_all_begin"
    | "stop_all_progress"
    | "stop_all_done"
    | "error_from_server";
  serviceID?: string;
  serviceName?: string;
  result?: "starting" | "started" | "failed" | "skipped" | "stopped";
  dependencyName?: string;
  total?: number;
  started?: number;
  failed?: number;
  skipped?: number;
  stopped?: number;
  services?: Array<{
    id: string;
    name?: string;
    status: string;
    errorDetails?: string;
    logs: LogEntry[];
    webLinks?: WebLink[];
    signals?: ServiceSignal[];
    dependsOn?: string[];
  }>;
  line?: string;
  logType?: string;
  timestamp?: number;
  status?: string;
  errorDetails?: string;
  message?: string;
  webLinks?: WebLink[];
}

export interface AutoScrollStates {
  [serviceId: string]: boolean;
}

export type StartAllStatusType =
  | "idle"
  | "progress"
  | "success"
  | "error"
  | "warning";

export interface StartAllStatus {
  message: string;
  type: StartAllStatusType;
}

export interface ServicesConfigResponse {
  dashboardName: string;
  services: ServiceConfig[];
}
