import { logMessage } from "./utils";
import { ServiceManager } from "./service-manager";
import { type WebSocket } from "ws";

export class WebSocketHandler {
  private serviceManager: ServiceManager;

  constructor(serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
  }

  handleConnection(ws: WebSocket) {
    logMessage("info", `WebSocket client connected`);

    // Send initial state
    this.sendInitialState(ws);

    // Handle messages
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (err: any) {
        logMessage("error", "WS message processing error:", err);
        this.sendError(ws, `Error: ${err.message}`);
      }
    });

    ws.on("close", () => {
      logMessage("info", "WS client disconnected");
    });

    ws.on("error", (err) => {
      logMessage("error", "WS error:", err);
    });
  }

  private sendInitialState(ws: WebSocket) {
    const initialState = {
      type: "initial_state",
      services: this.serviceManager.getServices().map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        logs: s.logs,
        errorDetails: s.errorDetails,
        webLinks: s.webLinks || [],
      })),
    };

    ws.send(JSON.stringify(initialState));
  }

  private async handleMessage(ws: WebSocket, data: any) {
    const { action, serviceID } = data;
    logMessage("info", "WS RCV:", data);

    if (!this.serviceManager.getService(serviceID)) {
      logMessage("error", `Invalid serviceID: ${serviceID}`);
      this.sendError(ws, `Invalid serviceID: ${serviceID}`);
      return;
    }

    switch (action) {
      case "start":
        await this.serviceManager.startService(serviceID);
        break;
      case "stop":
        await this.serviceManager.stopService(serviceID);
        break;
      case "restart":
        await this.serviceManager.restartService(serviceID);
        break;
      case "clear_logs":
        this.serviceManager.clearServiceLogs(serviceID);
        break;
      default:
        logMessage("warn", `Unknown action: ${action}`);
        this.sendError(ws, `Unknown action: ${action}`);
    }
  }

  private sendError(ws: WebSocket, message: string) {
    ws.send(
      JSON.stringify({
        type: "error_from_server",
        message,
      }),
    );
  }
}
