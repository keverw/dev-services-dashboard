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

// How long stop() waits for each server's close() callback before giving up.
// On Node the close resolves effectively instantly, so this deadline only bites
// on runtimes that don't fire the callback after a WebSocket upgrade has
// occurred (e.g. Bun), where it keeps shutdown from hanging. Kept short so a
// Ctrl+C feels snappy there; localhost servers drain well under this on Node.
const STOP_CLOSE_DEADLINE_MS = 500;

// Awaits a server `close()` but resolves after `deadlineMs` regardless, so a
// runtime that never invokes the close callback can't hang shutdown. Close
// errors are swallowed (resolve, not reject): the common one is
// `ERR_SERVER_NOT_RUNNING` when the server is already closed (e.g. closing the
// `ws` server first tears down the shared HTTP server on some runtimes), which
// is a benign no-op — stop() is best-effort and shouldn't reject on it.
function closeServerWithDeadline(
  close: (cb: (err?: Error) => void) => void,
  deadlineMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, deadlineMs);
    close(() => finish());
  });
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

      // Tracks whether the start promise has settled, so the `error` handler can
      // tell a failed bind (reject) from a later runtime error on an
      // already-running server (just log it).
      let settled = false;

      // Attach the error handler BEFORE listen(): some runtimes (e.g. Bun)
      // attempt the bind synchronously and emit `error` during the listen() call
      // itself, so a handler registered afterwards would miss it and the bind
      // failure would surface as an unhandled `error` event.
      httpServer.on("error", (error) => {
        if (settled) {
          // The server already came up; this is a later runtime error on an
          // already-running server — just log it.
          logger.error("Dev Services Dashboard server error:", error as object);
          return;
        }

        // The instance never came up — reject the start promise.
        settled = true;
        logger.error(
          "Fatal error starting Dev Services Dashboard server:",
          error as object,
        );
        reject(error);
      });

      // Start server. The WebSocket server is attached only AFTER the HTTP
      // server is actually listening: a `WebSocketServer({ server })` registers
      // its own `error` listener on the HTTP server, and on a failed bind that
      // listener throws (the ws server has no `error` handler), which both
      // pre-empts our handler above and surfaces as an uncaught exception. By
      // wiring it up inside the listen callback, the bind window stays clean so
      // a bind failure rejects the start promise instead of crashing the process.
      httpServer.listen(PORT, HOSTNAME, () => {
        settled = true;
        logger.info(
          `Dev Services Dashboard server running on http://${HOSTNAME}:${PORT}`,
        );

        wsServer = new WebSocketServer({ server: httpServer });
        const wsHandler = new WebSocketHandler(logger, serviceManager);
        wsServer.on("connection", (ws) => {
          wsHandler.handleConnection(ws);
        });

        resolve({
          httpServer,
          wsServer,
          port: PORT,
          stop: async () => {
            // Latch shutdown first so no client action (or in-flight start
            // waiter) can resurrect a service while/after we stop them.
            serviceManager.beginShutdown();
            await serviceManager.stopAllServices();

            // Terminate live WebSocket clients first: otherwise wsServer.close()
            // waits on them, and their still-open sockets keep the HTTP server
            // alive so its close() can't complete.
            for (const client of wsServer.clients) client.terminate();

            // Await each close so a resolved stop() means the servers have
            // actually drained — but bound the wait (see STOP_CLOSE_DEADLINE_MS)
            // so a runtime that doesn't fire the close callback after a
            // WebSocket upgrade (e.g. Bun) can't hang shutdown.
            await closeServerWithDeadline(
              (cb) => wsServer.close(cb),
              STOP_CLOSE_DEADLINE_MS,
            );

            // Drop idle keep-alive HTTP sockets so close() can finish promptly
            // on runtimes that support it.
            httpServer.closeAllConnections?.();
            await closeServerWithDeadline(
              (cb) => httpServer.close(cb),
              STOP_CLOSE_DEADLINE_MS,
            );
          },
        });
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
