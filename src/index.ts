import { WebSocketServer, WebSocket } from "ws";
import { logMessage } from "./backend/utils";
import { ServiceManager } from "./backend/service-manager";
import { DevUIConfig, DevUIServer } from "./backend/types";
import { HttpHandler } from "./backend/http-handler";
import { createServer } from "http";
import { WebSocketHandler } from "./backend/web-socket-handler";

// --- Main export function ---
export function startDevUI(config: DevUIConfig): Promise<DevUIServer> {
  const PORT = config.port || 4000;
  const HOSTNAME = config.hostname || "localhost";
  const MAX_LOG_LINES = config.maxLogLines || 200;

  return new Promise((resolve, reject) => {
    try {
      // Create broadcast function for WebSocket clients
      let wsServer: WebSocketServer;
      const broadcast = (message: object) => {
        const msgString = JSON.stringify(message);
        wsServer.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msgString);
          }
        });
      };

      // Initialize service manager
      const serviceManager = new ServiceManager(
        config.services,
        MAX_LOG_LINES,
        broadcast,
        config.defaultCwd,
      );

      // Initialize HTTP handler
      const httpHandler = new HttpHandler(serviceManager);

      // Create HTTP server
      const httpServer = createServer((req, res) => {
        httpHandler.handleRequest(req, res);
      });

      // Create WebSocket server
      wsServer = new WebSocketServer({ server: httpServer });
      const wsHandler = new WebSocketHandler(serviceManager);

      wsServer.on("connection", (ws) => {
        wsHandler.handleConnection(ws);
      });

      // Shutdown handler
      const handleShutdownSignal = async (signal: string) => {
        logMessage(
          "info",
          `Received ${signal}. Shutting down Dev UI server and services...`,
        );

        await serviceManager.stopAllServices();

        logMessage("info", "Stopping Dev UI HTTP server...");
        httpServer.close();
        wsServer.close();
        process.exit(0);
      };

      process.on("SIGINT", handleShutdownSignal);
      process.on("SIGTERM", handleShutdownSignal);

      // Start server
      httpServer.listen(PORT, HOSTNAME, () => {
        logMessage(
          "info",
          `Dev UI server running on http://${HOSTNAME}:${PORT}`,
        );

        resolve({
          httpServer,
          wsServer,
          stop: async () => {
            await serviceManager.stopAllServices();
            httpServer.close();
            wsServer.close();
          },
        });
      });

      httpServer.on("error", (error) => {
        logMessage("error", "Fatal error starting Dev UI server:", error);
        reject(error);
      });
    } catch (error) {
      logMessage("error", "Fatal error starting Dev UI server:", error);
      reject(error);
    }
  });
}

// Export all types and functions from the module
export * from "./backend/types";
