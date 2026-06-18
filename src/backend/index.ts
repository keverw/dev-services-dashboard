import { WebSocketServer, WebSocket } from "ws";
import { Logger } from "./logger";
import { ServiceManager } from "./service-manager";
import { DevUIConfig, DevUIServer } from "./types";
import type { ServerMessage } from "@shared/protocol";
import { HttpHandler } from "./http-handler";
import { createServer } from "http";
import { WebSocketHandler } from "./web-socket-handler";

// --- Main export function ---
export function startDevServicesDashboard(
  config: DevUIConfig,
): Promise<DevUIServer> {
  const PORT = config.port || 4000;
  const HOSTNAME = config.hostname || "localhost";
  const MAX_LOG_LINES = config.maxLogLines || 200;

  // Create logger - use provided logger or no logging if none provided
  const logger = new Logger(config.logger);

  return new Promise((resolve, reject) => {
    try {
      // Create broadcast function for WebSocket clients
      let wsServer: WebSocketServer;
      const broadcast = (message: ServerMessage) => {
        const msgString = JSON.stringify(message);
        wsServer.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msgString);
          }
        });
      };

      // Initialize service manager
      const serviceManager = new ServiceManager(
        logger,
        config.services,
        MAX_LOG_LINES,
        broadcast,
        config.defaultCwd,
        {
          stopTimeout: config.stopTimeout,
          startTimeout: config.startTimeout,
          beforeStartTimeout: config.beforeStartTimeout,
          afterStartTimeout: config.afterStartTimeout,
        },
      );

      // Initialize HTTP handler
      const httpHandler = new HttpHandler(
        logger,
        serviceManager,
        config.dashboardName,
      );

      // Create HTTP server
      const httpServer = createServer((req, res) => {
        httpHandler.handleRequest(req, res);
      });

      // Create WebSocket server
      wsServer = new WebSocketServer({ server: httpServer });
      const wsHandler = new WebSocketHandler(logger, serviceManager);

      wsServer.on("connection", (ws) => {
        wsHandler.handleConnection(ws);
      });

      // Shutdown handler
      const handleShutdownSignal = async (signal: string) => {
        logger.info(
          `Received ${signal}. Shutting down Dev Services Dashboard server and services...`,
        );

        await serviceManager.stopAllServices();

        logger.info("Stopping Dev Services Dashboard HTTP server...");
        httpServer.close();
        wsServer.close();
        process.exit(0);
      };

      // Store signal handler references for cleanup
      const sigintHandler = () => handleShutdownSignal("SIGINT");
      const sigtermHandler = () => handleShutdownSignal("SIGTERM");

      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);

      // Start server
      httpServer.listen(PORT, HOSTNAME, () => {
        logger.info(
          `Dev Services Dashboard server running on http://${HOSTNAME}:${PORT}`,
        );

        resolve({
          httpServer,
          wsServer,
          port: PORT,
          stop: async () => {
            // Remove signal handlers to prevent interference
            process.removeListener("SIGINT", sigintHandler);
            process.removeListener("SIGTERM", sigtermHandler);

            await serviceManager.stopAllServices();
            httpServer.close();
            wsServer.close();
          },
        });
      });

      httpServer.on("error", (error) => {
        logger.error(
          "Fatal error starting Dev Services Dashboard server:",
          error as object,
        );
        reject(error);
      });
    } catch (error) {
      logger.error(
        "Fatal error starting Dev Services Dashboard server:",
        error as object,
      );
      reject(error);
    }
  });
}

// Public type surface. Kept explicit (rather than `export *`) so internal
// runtime types like `Service` stay out of the published API.
export type {
  DevUIConfig,
  DevUIServer,
  UserServiceConfig,
  DevServicesDashboardLoggerFunction,
  BeforeStartContext,
  BeforeStartResult,
  AfterStartContext,
  AfterStartResult,
} from "./types";
// `WebLink` / `ServiceSignal` live in the shared wire protocol but are part of
// the documented config surface (they appear in `UserServiceConfig`).
export type { WebLink, ServiceSignal } from "@shared/protocol";
// The wire protocol types for the WebSocket frames sent over `DevUIServer.wsServer`.
// Exported so a consumer reading raw messages off the exposed `ws` server can
// type them (and to back the future potentially planned headless mode).
export type {
  ServerMessage,
  ClientMessage,
  InitialStateService,
  LogEntry,
  ServiceStatusValue,
  // Per-service outcomes carried in the Start All / Stop All progress frames'
  // `result` field (part of `ServerMessage`); exported so consumers reading
  // those frames can name the type directly.
  StartAllResult,
  StopAllResult,
} from "@shared/protocol";
export { createConsoleLogger } from "./logger";
