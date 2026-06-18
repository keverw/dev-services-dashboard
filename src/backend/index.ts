import { WebSocketServer, WebSocket } from "ws";
import { Logger } from "./logger";
import {
  ServiceManager,
  positiveOr,
  nonEmptyStringOr,
} from "./service-manager";
import { DevUIConfig, DevUIServer } from "./types";
import type { ServerMessage } from "@shared/protocol";
import { HttpHandler } from "./http-handler";
import { createServer } from "http";
import { WebSocketHandler } from "./web-socket-handler";

// Module-level shutdown registry so multiple startDevServicesDashboard calls in
// a single process share ONE pair of SIGINT/SIGTERM handlers instead of each
// stacking its own (N handlers all racing to call process.exit). Each instance
// registers its own shutdown routine; the shared handler runs them all, then
// exits once. stop() unregisters, and the process listeners are removed once the
// last dashboard is gone so stop() fully detaches the dashboard from the process.
const activeShutdowns = new Set<(signal: string) => Promise<void>>();
let processSignalsInstalled = false;

const handleProcessSignal = (signal: string) => {
  void (async () => {
    await Promise.all([...activeShutdowns].map((fn) => fn(signal)));
    process.exit(0);
  })();
};

const sigintListener = () => handleProcessSignal("SIGINT");
const sigtermListener = () => handleProcessSignal("SIGTERM");

function registerShutdown(fn: (signal: string) => Promise<void>): void {
  activeShutdowns.add(fn);
  if (!processSignalsInstalled) {
    processSignalsInstalled = true;
    process.on("SIGINT", sigintListener);
    process.on("SIGTERM", sigtermListener);
  }
}

function unregisterShutdown(fn: (signal: string) => Promise<void>): void {
  activeShutdowns.delete(fn);
  if (activeShutdowns.size === 0 && processSignalsInstalled) {
    processSignalsInstalled = false;
    process.removeListener("SIGINT", sigintListener);
    process.removeListener("SIGTERM", sigtermListener);
  }
}

// --- Main export function ---
export function startDevServicesDashboard(
  config: DevUIConfig,
): Promise<DevUIServer> {
  // `positiveOr` so 0, negatives, and non-finite values fall back to the
  // default (a negative `maxLogLines` would otherwise empty the buffer on every
  // line; a negative `port` is invalid). `nonEmptyStringOr` does the same for
  // `hostname`: a non-string, empty, or whitespace-only value falls back to the
  // default, and a valid one is trimmed so stray whitespace can't break binding.
  const PORT = positiveOr(config.port, 4000);
  const HOSTNAME = nonEmptyStringOr(config.hostname, "localhost");
  const MAX_LOG_LINES = positiveOr(config.maxLogLines, 200);
  // Same guard as `hostname`: a non-string, empty, or whitespace-only
  // `dashboardName` falls back to the default, and a valid one is trimmed.
  const DASHBOARD_NAME = nonEmptyStringOr(
    config.dashboardName,
    "Dev Services Dashboard",
  );

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
        DASHBOARD_NAME,
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

      // Per-instance shutdown routine, registered into the shared process-signal
      // handler (which exits once after running every active dashboard's). This
      // stops services and closes this instance's server but does NOT exit — the
      // shared handler owns process.exit so multiple dashboards don't race it.
      const shutdown = async (signal: string) => {
        logger.info(
          `Received ${signal}. Shutting down Dev Services Dashboard server and services...`,
        );

        await serviceManager.stopAllServices();

        logger.info("Stopping Dev Services Dashboard HTTP server...");
        httpServer.close();
        wsServer.close();
      };

      registerShutdown(shutdown);

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
            // Detach this instance from the shared process-signal handler.
            unregisterShutdown(shutdown);

            await serviceManager.stopAllServices();
            httpServer.close();
            wsServer.close();
          },
        });
      });

      httpServer.on("error", (error) => {
        // The instance never came up — detach it so a failed bind doesn't leave
        // a registered shutdown (and a stray process-signal handler) behind.
        unregisterShutdown(shutdown);
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
