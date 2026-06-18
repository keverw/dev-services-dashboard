// Frontend-local view types. Wire types (the WebSocket message contract, web
// links, signals, statuses) come from the shared protocol — import them from
// "@shared/protocol" directly where needed. This app is bundled and embedded
// into the backend package rather than imported as a module, so there's no
// public type surface to re-export here (unlike the backend's types.ts).
import type {
  WebLink,
  ServiceSignal,
  ServiceStatusValue,
} from "@shared/protocol";

export interface ServiceConfig {
  id: string;
  name: string;
  webLinks?: WebLink[];
  signals?: ServiceSignal[];
  dependsOn?: string[];
}

export interface ServiceStatus {
  id: string;
  status: ServiceStatusValue;
  errorDetails?: string;
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
