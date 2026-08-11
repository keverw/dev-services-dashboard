import { IncomingMessage, ServerResponse } from "http";
import { ServiceManager } from "./service-manager";
import { Logger } from "./logger";
import { Service } from "./types";
import type { LogEntry } from "@shared/protocol";
import type {
  ApiErrorCode,
  ApiIndexResponse,
  ServiceSummary,
} from "@shared/control-api";

/** Every control-API path lives under this prefix. */
export const API_PREFIX = "/api/v1";

/**
 * Cap on a request body. Every body this API accepts is a tiny JSON object, so
 * anything larger is a mistake or an attack; rejecting early keeps a large
 * upload from being buffered in memory.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How long to wait for a request body before giving up. Without this, a
 * half-open request could hold a socket past the point where `stop()` wants to
 * close the HTTP server.
 */
const BODY_READ_TIMEOUT_MS = 10_000;

/** Default number of log entries returned when `limit` isn't given. */
const DEFAULT_LOG_LIMIT = 100;

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  service_not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  forbidden_origin: 403,
  start_failed: 409,
  stop_failed: 409,
  service_not_running: 409,
  start_all_busy: 409,
  signal_not_allowed: 422,
  shutting_down: 503,
  internal_error: 500,
};

const ROUTE_INDEX: ApiIndexResponse["routes"] = [
  { method: "GET", path: "/api/v1/health", summary: "Dashboard reachability." },
  {
    method: "GET",
    path: "/api/v1/services",
    summary: "List every service with its current status.",
  },
  {
    method: "GET",
    path: "/api/v1/services/:id",
    summary: "Get one service's status.",
  },
  {
    method: "POST",
    path: "/api/v1/services/:id/start",
    summary: "Start a service. Waits for the outcome unless {wait:false}.",
  },
  {
    method: "POST",
    path: "/api/v1/services/:id/stop",
    summary: "Stop a service.",
  },
  {
    method: "POST",
    path: "/api/v1/services/:id/restart",
    summary: "Restart a service. Waits for the outcome unless {wait:false}.",
  },
  {
    method: "POST",
    path: "/api/v1/services/:id/signal",
    summary: 'Send a declared signal, e.g. {"signal":"SIGHUP"}.',
  },
  {
    method: "GET",
    path: "/api/v1/services/:id/logs",
    summary: "Buffered log lines. Query: limit, since, logType, format=text.",
  },
  {
    method: "DELETE",
    path: "/api/v1/services/:id/logs",
    summary: "Clear a service's log buffer.",
  },
  {
    method: "POST",
    path: "/api/v1/start-all",
    summary: "Start every service in dependency order.",
  },
  {
    method: "POST",
    path: "/api/v1/stop-all",
    summary: "Stop every service in reverse dependency order.",
  },
];

/**
 * Thrown internally to unwind to the single error responder in `handle`. Keeps
 * each route handler linear (validate, throw, act) instead of threading an
 * error return type through every helper.
 */
class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The JSON control API backing the CLI (and any external tool driving the
 * dashboard directly with `curl`).
 *
 * Kept out of `HttpHandler` — which is a small composition root for "static
 * assets, else the one legacy endpoint" — because this needs method matching,
 * path parameters, body parsing, and a consistent error envelope. Keeping it
 * separate also means it can be exercised without booting a server.
 *
 * ## Trust model
 *
 * There is no authentication, exactly as with the WebSocket and the web UI:
 * anything that can reach the port can start, stop, and signal processes. The
 * dashboard binds to `localhost` by default, and that is the assumption this API
 * is written under.
 *
 * The one exposure a REST API adds over the existing WebSocket is cross-origin
 * form/`fetch` POSTs from a random web page the developer happens to visit — a
 * CORS *simple request* needs no preflight, so the side effect would land even
 * though the attacker can't read the response. Two cheap guards close that
 * without introducing tokens: mutating requests must be `application/json`
 * (which is not a simple content type, so it forces a preflight that fails), and
 * a request carrying a cross-origin `Origin` header is rejected. Deliberately no
 * `Access-Control-Allow-*` headers are ever sent.
 */
export class ApiRouter {
  private readonly startedAt = Date.now();

  constructor(
    private readonly logger: Logger,
    private readonly serviceManager: ServiceManager,
    private readonly dashboardName: string,
  ) {}

  /** Whether this request belongs to the control API. */
  static handles(pathname: string): boolean {
    return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      await this.route(req, res, url);
    } catch (err) {
      if (err instanceof ApiFailure) {
        this.sendError(res, err.code, err.message, err.details);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Control API error:", err as object);
      this.sendError(res, "internal_error", message);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    // Trailing slashes are tolerated so `/api/v1/services/` behaves like
    // `/api/v1/services` — a common curl-by-hand slip.
    const path = url.pathname.replace(/\/+$/, "") || API_PREFIX;
    const segments = path.slice(API_PREFIX.length).split("/").filter(Boolean);

    this.assertSameOrigin(req);

    // GET /api/v1 — the self-describing index.
    if (segments.length === 0) {
      this.assertMethod(method, ["GET"]);
      const body: ApiIndexResponse = {
        ok: true,
        name: this.dashboardName,
        routes: ROUTE_INDEX,
      };
      this.sendJSON(res, 200, body);
      return;
    }

    if (segments[0] === "health" && segments.length === 1) {
      this.assertMethod(method, ["GET"]);
      this.sendJSON(res, 200, {
        ok: true,
        dashboardName: this.dashboardName,
        shuttingDown: this.serviceManager.isShuttingDown(),
        serviceCount: this.serviceManager.getServices().length,
        uptimeMs: Date.now() - this.startedAt,
      });
      return;
    }

    if (segments[0] === "start-all" && segments.length === 1) {
      this.assertMethod(method, ["POST"]);
      await this.readJSONBody(req);
      this.assertNotShuttingDown();

      const summary = await this.serviceManager.startAllServices();
      if (!summary.ran) {
        throw new ApiFailure(
          "start_all_busy",
          "A Start All run is already in progress.",
        );
      }

      this.sendJSON(res, 200, {
        ok: true,
        started: summary.started,
        failed: summary.failed,
        skipped: summary.skipped,
        total: summary.total,
        services: this.summaries(),
      });
      return;
    }

    if (segments[0] === "stop-all" && segments.length === 1) {
      this.assertMethod(method, ["POST"]);
      await this.readJSONBody(req);
      this.assertNotShuttingDown();

      const summary = await this.serviceManager.stopAllServices();
      this.sendJSON(res, 200, {
        ok: true,
        stopped: summary.stopped,
        failed: summary.failed,
        total: summary.total,
        services: this.summaries(),
      });
      return;
    }

    if (segments[0] === "services") {
      await this.routeServices(req, res, url, method, segments.slice(1));
      return;
    }

    throw new ApiFailure("not_found", `No such route: ${method} ${path}`);
  }

  private async routeServices(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    rest: string[],
  ) {
    // GET /api/v1/services
    if (rest.length === 0) {
      this.assertMethod(method, ["GET"]);
      this.sendJSON(res, 200, {
        ok: true,
        dashboardName: this.dashboardName,
        services: this.summaries(),
      });
      return;
    }

    const serviceID = decodeURIComponent(rest[0]);
    const service = this.serviceManager.getService(serviceID);
    if (!service) {
      throw new ApiFailure(
        "service_not_found",
        `No service with id "${serviceID}".`,
      );
    }

    // GET /api/v1/services/:id
    if (rest.length === 1) {
      this.assertMethod(method, ["GET"]);
      this.sendJSON(res, 200, { ok: true, service: toSummary(service) });
      return;
    }

    if (rest.length !== 2) {
      throw new ApiFailure(
        "not_found",
        `No such route: ${method} ${url.pathname}`,
      );
    }

    switch (rest[1]) {
      case "start":
        await this.handleStart(req, res, serviceID);
        return;
      case "stop":
        await this.handleStop(req, res, serviceID);
        return;
      case "restart":
        await this.handleRestart(req, res, serviceID);
        return;
      case "signal":
        await this.handleSignal(req, res, serviceID);
        return;
      case "logs":
        await this.handleLogs(req, res, url, method, serviceID);
        return;
      default:
        throw new ApiFailure(
          "not_found",
          `No such route: ${method} ${url.pathname}`,
        );
    }
  }

  private async handleStart(
    req: IncomingMessage,
    res: ServerResponse,
    serviceID: string,
  ) {
    this.assertMethod(req.method ?? "GET", ["POST"]);
    const body = await this.readJSONBody(req);
    this.assertNotShuttingDown();
    const wait = readWaitFlag(body);

    if (!wait) {
      void this.serviceManager.startAndWait(serviceID);
      this.sendJSON(res, 202, {
        ok: true,
        service: this.summaryOf(serviceID),
        waited: false,
      });
      return;
    }

    const ok = await this.serviceManager.startAndWait(serviceID);
    const service = this.summaryOf(serviceID);
    if (!ok) {
      throw new ApiFailure(
        "start_failed",
        `Service "${serviceID}" did not reach a running state.`,
        { status: service.status, errorDetails: service.errorDetails },
      );
    }

    this.sendJSON(res, 200, { ok: true, service, waited: true });
  }

  private async handleStop(
    req: IncomingMessage,
    res: ServerResponse,
    serviceID: string,
  ) {
    this.assertMethod(req.method ?? "GET", ["POST"]);
    await this.readJSONBody(req);
    this.assertNotShuttingDown();

    await this.serviceManager.stopService(serviceID);
    const service = this.summaryOf(serviceID);

    // A service that was already `error`/`crashed` stays in that state after a
    // stop — the process is gone either way, so that's a successful stop, not a
    // failure. Only a still-live state means the stop didn't take.
    if (
      service.status !== "stopped" &&
      service.status !== "error" &&
      service.status !== "crashed"
    ) {
      throw new ApiFailure(
        "stop_failed",
        `Service "${serviceID}" is ${service.status} after the stop.`,
        { status: service.status },
      );
    }

    this.sendJSON(res, 200, { ok: true, service });
  }

  private async handleRestart(
    req: IncomingMessage,
    res: ServerResponse,
    serviceID: string,
  ) {
    this.assertMethod(req.method ?? "GET", ["POST"]);
    const body = await this.readJSONBody(req);
    this.assertNotShuttingDown();
    const wait = readWaitFlag(body);

    if (!wait) {
      void this.serviceManager.restartService(serviceID);
      this.sendJSON(res, 202, {
        ok: true,
        service: this.summaryOf(serviceID),
        waited: false,
      });
      return;
    }

    const ok = await this.serviceManager.restartService(serviceID);
    const service = this.summaryOf(serviceID);
    if (!ok) {
      throw new ApiFailure(
        "start_failed",
        `Service "${serviceID}" did not come back up after the restart.`,
        { status: service.status, errorDetails: service.errorDetails },
      );
    }

    this.sendJSON(res, 200, { ok: true, service, waited: true });
  }

  private async handleSignal(
    req: IncomingMessage,
    res: ServerResponse,
    serviceID: string,
  ) {
    this.assertMethod(req.method ?? "GET", ["POST"]);
    const body = await this.readJSONBody(req);
    this.assertNotShuttingDown();

    const signal = body?.signal;
    if (typeof signal !== "string" || signal.length === 0) {
      throw new ApiFailure(
        "bad_request",
        'A non-empty "signal" is required, e.g. {"signal":"SIGHUP"}.',
      );
    }

    const result = this.serviceManager.sendSignal(serviceID, signal);
    switch (result) {
      case "sent":
        this.sendJSON(res, 200, { ok: true, serviceID, signal });
        return;
      case "not_running":
        throw new ApiFailure(
          "service_not_running",
          `Service "${serviceID}" is not running, so "${signal}" was not sent.`,
          { status: this.summaryOf(serviceID).status },
        );
      case "not_declared":
        throw new ApiFailure(
          "signal_not_allowed",
          `Service "${serviceID}" does not declare "${signal}" in its signals list.`,
          {
            allowed: (this.summaryOf(serviceID).signals ?? []).map(
              (s) => s.signal,
            ),
          },
        );
      case "unknown_signal":
        throw new ApiFailure(
          "signal_not_allowed",
          `"${signal}" is not a known signal name.`,
        );
      case "service_not_found":
        throw new ApiFailure(
          "service_not_found",
          `No service with id "${serviceID}".`,
        );
      case "send_failed":
        throw new ApiFailure(
          "internal_error",
          `Failed to send "${signal}" to "${serviceID}".`,
        );
    }
  }

  private async handleLogs(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    serviceID: string,
  ) {
    if (method === "DELETE") {
      this.assertNotShuttingDown();
      this.serviceManager.clearServiceLogs(serviceID);
      this.sendJSON(res, 200, { ok: true, serviceID });
      return;
    }

    this.assertMethod(method, ["GET", "DELETE"]);

    const service = this.serviceManager.getService(serviceID)!;
    const bufferLimit = this.serviceManager.getMaxLogLines();
    const bufferSize = service.logs.length;

    let entries: LogEntry[] = service.logs;

    const typeParam = url.searchParams.get("logType");
    if (typeParam) {
      const wanted = new Set(
        typeParam
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      );
      for (const t of wanted) {
        if (t !== "stdout" && t !== "stderr" && t !== "system") {
          throw new ApiFailure(
            "bad_request",
            `Unknown logType "${t}". Expected stdout, stderr, or system.`,
          );
        }
      }
      entries = entries.filter((e) => wanted.has(e.logType));
    }

    const since = readIntParam(url, "since");
    if (since !== undefined) {
      entries = entries.filter((e) => e.timestamp > since);
    }

    const limit = readIntParam(url, "limit") ?? DEFAULT_LOG_LIMIT;
    if (limit < 0) {
      throw new ApiFailure("bad_request", '"limit" must not be negative.');
    }
    // The tail, not the head: the newest lines are what a caller asking for
    // "the last N" wants.
    if (entries.length > limit) entries = entries.slice(entries.length - limit);

    if (url.searchParams.get("format") === "text") {
      // An entry is one chunk of output, not one line: it carries its trailing
      // newline and may hold several embedded ones. Expand them so each printed
      // line is prefixed and the result stays greppable.
      const text = entries
        .flatMap((e) => {
          const stamp = `${new Date(e.timestamp).toISOString()} [${e.logType}]`;
          return e.line
            .replace(/\r?\n$/, "")
            .split("\n")
            .map((line) => `${stamp} ${line}`);
        })
        .join("\n");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text.length > 0 ? `${text}\n` : "");
      return;
    }

    this.sendJSON(res, 200, {
      ok: true,
      serviceID,
      entries,
      returned: entries.length,
      bufferSize,
      bufferLimit,
      // At the cap, older lines have already been evicted — a `since` poller
      // needs to know it may have missed some.
      truncated: bufferSize >= bufferLimit,
    });
  }

  // --- helpers ---

  private summaries(): ServiceSummary[] {
    return this.serviceManager.getServices().map(toSummary);
  }

  private summaryOf(serviceID: string): ServiceSummary {
    return toSummary(this.serviceManager.getService(serviceID)!);
  }

  private assertMethod(method: string, allowed: string[]) {
    if (!allowed.includes(method)) {
      throw new ApiFailure(
        "method_not_allowed",
        `${method} is not allowed here. Allowed: ${allowed.join(", ")}.`,
        { allow: allowed },
      );
    }
  }

  /**
   * Mirrors the WebSocket handler's shutdown guard: once `stop()` has begun,
   * no client may start, stop, or signal anything. Reads stay available so a
   * caller can still ask what happened while the dashboard tears down.
   */
  private assertNotShuttingDown() {
    if (this.serviceManager.isShuttingDown()) {
      throw new ApiFailure("shutting_down", "Dashboard is shutting down.");
    }
  }

  /**
   * Rejects a request whose `Origin` isn't this server. Browsers set `Origin`
   * on cross-origin requests but tools like curl omit it entirely, so an absent
   * header is allowed through — this is a CSRF guard, not authentication.
   */
  private assertSameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return;

    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiFailure("forbidden_origin", `Invalid Origin: ${origin}`);
    }

    if (originHost !== req.headers.host) {
      throw new ApiFailure(
        "forbidden_origin",
        `Cross-origin request from ${origin} refused.`,
      );
    }
  }

  /**
   * Reads and parses a JSON request body, enforcing the content type on any
   * method that can mutate state. An empty body counts as `{}` so
   * `curl -X POST -H 'Content-Type: application/json'` works with no `-d`.
   */
  private readJSONBody(
    req: IncomingMessage,
  ): Promise<Record<string, unknown> | undefined> {
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
      return Promise.resolve(undefined);
    }

    // Requiring a non-simple content type is what forces a CORS preflight on
    // cross-origin POSTs, which then fails since we send no CORS headers.
    const contentType = (req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new ApiFailure(
        "unsupported_media_type",
        "Content-Type must be application/json.",
      );
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new ApiFailure(
              "bad_request",
              "Timed out reading the request body.",
            ),
          ),
        );
      }, BODY_READ_TIMEOUT_MS);

      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(() =>
            reject(
              new ApiFailure(
                "bad_request",
                `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
              ),
            ),
          );
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        finish(() => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          if (raw.length === 0) {
            resolve({});
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              reject(
                new ApiFailure(
                  "bad_request",
                  "Request body must be a JSON object.",
                ),
              );
              return;
            }
            resolve(parsed as Record<string, unknown>);
          } catch {
            reject(
              new ApiFailure("bad_request", "Request body is not valid JSON."),
            );
          }
        });
      };

      const onError = (err: Error) => {
        finish(() =>
          reject(
            new ApiFailure("bad_request", `Error reading body: ${err.message}`),
          ),
        );
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
    });
  }

  private sendJSON(res: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      // This is live process state; a cached answer is always wrong.
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  private sendError(
    res: ServerResponse,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    if (res.headersSent) return;

    if (code === "method_not_allowed" && Array.isArray(details?.allow)) {
      res.setHeader("Allow", (details.allow as string[]).join(", "));
    }

    this.sendJSON(res, ERROR_STATUS[code], {
      ok: false,
      error: details ? { code, message, details } : { code, message },
    });
  }
}

/**
 * Maps the internal `Service` onto its public view.
 *
 * This mapper is the only thing that should ever produce an API service object.
 * `Service` holds a live `ChildProcess` (circular, so `JSON.stringify` throws)
 * plus the resolved `env` and `command`, and this API is unauthenticated — so
 * the safe fields are listed explicitly here rather than spread from the source.
 */
function toSummary(service: Service): ServiceSummary {
  const logs = service.logs;
  return {
    id: service.id,
    name: service.name,
    status: service.status,
    errorDetails: service.errorDetails,
    pid: service.process?.pid ?? null,
    webLinks: service.liveWebLinks ?? service.webLinks ?? [],
    signals: service.signals ?? [],
    dependsOn: service.dependsOn ?? [],
    logCount: logs.length,
    lastLogAt: logs.length > 0 ? logs[logs.length - 1].timestamp : null,
  };
}

/** Reads the `wait` flag, defaulting to true (block until the outcome is known). */
function readWaitFlag(body: Record<string, unknown> | undefined): boolean {
  const wait = body?.wait;
  if (wait === undefined) return true;
  if (typeof wait !== "boolean") {
    throw new ApiFailure("bad_request", '"wait" must be a boolean.');
  }
  return wait;
}

function readIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ApiFailure("bad_request", `"${name}" must be an integer.`);
  }
  return value;
}
