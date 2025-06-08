export interface ServiceConfig {
  id: string;
  name: string;
  webLinks?: WebLink[];
}

export interface WebLink {
  label: string;
  url: string;
}

export interface LogEntry {
  line: string;
  logType: "stdout" | "stderr" | "system";
  timestamp: number;
}

export interface ServiceStatus {
  id: string;
  status: "stopped" | "running" | "starting" | "stopping" | "error" | "crashed";
  errorDetails?: string;
}

export interface WebSocketMessage {
  type:
    | "initial_state"
    | "log"
    | "status_update"
    | "logs_cleared"
    | "error_from_server";
  serviceID?: string;
  services?: Array<{
    id: string;
    status: string;
    errorDetails?: string;
    logs: LogEntry[];
  }>;
  line?: string;
  logType?: string;
  timestamp?: number;
  status?: string;
  errorDetails?: string;
  message?: string;
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
