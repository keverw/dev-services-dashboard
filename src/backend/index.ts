import { WebSocketServer, WebSocket } from "ws";
import { Logger } from "./logger";
import { ServiceManager } from "./service-manager";
import { DevUIConfig, DevUIServer } from "./types";
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
        logger,
        config.services,
        MAX_LOG_LINES,
        broadcast,
        config.defaultCwd,
      );

      // Initialize HTTP handler
      const httpHandler = new HttpHandler(logger, serviceManager);

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

// Export all types and functions from the module
export * from "./types";
export { createConsoleLogger } from "./logger";
