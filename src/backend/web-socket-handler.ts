import { Logger } from "./logger";
import { ServiceManager } from "./service-manager";
import { type WebSocket } from "ws";
import type { ServerMessage } from "@shared/protocol";

export class WebSocketHandler {
  private serviceManager: ServiceManager;
  private logger: Logger;

  constructor(logger: Logger, serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
    this.logger = logger;
  }

  handleConnection(ws: WebSocket) {
    this.logger.info(`WebSocket client connected`);

    // Send initial state
    this.sendInitialState(ws);

    // Handle messages
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(ws, message);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error("WS message processing error:", err as object);
        this.sendError(ws, `Error: ${message}`);
      }
    });

    ws.on("close", () => {
      this.logger.info("WS client disconnected");
    });

    ws.on("error", (err) => {
      this.logger.error("WS error:", err);
    });
  }

  private sendInitialState(ws: WebSocket) {
    const initialState: ServerMessage = {
      type: "initial_state",
      services: this.serviceManager.getServices().map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        logs: s.logs,
        errorDetails: s.errorDetails,
        webLinks: s.liveWebLinks ?? s.webLinks ?? [],
        signals: s.signals || [],
        dependsOn: s.dependsOn || [],
      })),
    };

    ws.send(JSON.stringify(initialState));
  }

  private async handleMessage(ws: WebSocket, data: Record<string, unknown>) {
    const { action, serviceID } = data as {
      action: string;
      serviceID: string;
    };
    this.logger.info("WS RCV:", data);

    // The server is shutting down (stop()): reject every action so a late frame
    // can't start, restart, or otherwise touch services as they're torn down.
    // The shutdown stops services through the manager directly, not via here.
    if (this.serviceManager.isShuttingDown()) {
      this.sendError(ws, "Dashboard is shutting down.");
      return;
    }

    // Global actions that don't target a specific service.
    if (action === "start_all") {
      await this.serviceManager.startAllServices();
      return;
    }

    if (action === "stop_all") {
      await this.serviceManager.stopAllServices();
      return;
    }

    // Validate the action before the serviceID so an unrecognized action always
    // reports "Unknown action" rather than being masked by an "Invalid serviceID"
    // error when the frame also lacks a valid serviceID.
    const serviceActions = [
      "start",
      "stop",
      "restart",
      "clear_logs",
      "send_signal",
    ];

    if (!serviceActions.includes(action)) {
      this.logger.warn(`Unknown action: ${action}`);
      this.sendError(ws, `Unknown action: ${action}`);
      return;
    }

    if (!this.serviceManager.getService(serviceID)) {
      this.logger.error(`Invalid serviceID: ${serviceID}`);
      this.sendError(ws, `Invalid serviceID: ${serviceID}`);
      return;
    }

    switch (action) {
      case "start":
        // Use the timeout-aware start path (same as Start All) so a hung
        // beforeStart/afterStart can't park the service in
        // initializing/finalizing forever.
        await this.serviceManager.startAndWait(serviceID);
        break;
      case "stop": {
        // `force` skips SIGTERM and the grace period. Only an explicit `true`
        // counts, so a stray value can't turn a normal stop into a kill.
        const { force } = data as { force?: unknown };
        await this.serviceManager.stopService(serviceID, {
          force: force === true,
        });
        break;
      }
      case "restart":
        await this.serviceManager.restartService(serviceID);
        break;
      case "clear_logs":
        this.serviceManager.clearServiceLogs(serviceID);
        break;
      case "send_signal": {
        const { signal } = data as { signal?: string };

        if (typeof signal !== "string" || signal.length === 0) {
          this.logger.warn(`send_signal missing signal for ${serviceID}`);
          this.sendError(ws, "send_signal requires a signal");
          break;
        }

        this.serviceManager.sendSignal(serviceID, signal);
        break;
      }
    }
  }

  private sendError(ws: WebSocket, message: string) {
    const error: ServerMessage = { type: "error_from_server", message };
    ws.send(JSON.stringify(error));
  }
}
