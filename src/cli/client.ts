import type { ApiError, ApiErrorCode } from "@shared/control-api";
import { EXIT, type ExitCode } from "./exit-codes";

/**
 * The outcome of one API call.
 *
 * A discriminated union rather than exceptions: every caller has to deal with
 * "the dashboard isn't running" as an ordinary case, and the exit code depends
 * on which arm it lands in.
 */
export type ApiResult<T> =
  | { kind: "ok"; status: number; data: T }
  | { kind: "api"; status: number; error: ApiError }
  | { kind: "unreachable"; message: string }
  | { kind: "unexpected"; message: string };

/** Maps an API failure code onto the process exit code it should produce. */
export function exitCodeForApiError(code: ApiErrorCode): ExitCode {
  switch (code) {
    case "service_not_found":
      return EXIT.NO_SERVICE;
    case "shutting_down":
      return EXIT.SHUTTING_DOWN;
    case "signal_not_allowed":
      return EXIT.SIGNAL_NOT_ALLOWED;
    case "start_failed":
    case "stop_failed":
    case "service_not_running":
    case "start_all_busy":
      return EXIT.FAILED;
    case "bad_request":
      return EXIT.USAGE;
    case "internal_error":
      return EXIT.INTERNAL;
    case "not_found":
    case "method_not_allowed":
    case "unsupported_media_type":
    case "forbidden_origin":
      return EXIT.UNEXPECTED;
  }
}

export interface ClientOptions {
  baseURL: string;
  /** Milliseconds before giving up; 0 (the default for start-like commands) waits forever. */
  timeoutMs: number;
}

/**
 * Minimal fetch wrapper over the control API.
 *
 * Uses only globals and `node:` builtins on purpose — the CLI must not pull
 * `ws` or `mime-types` into its bundle, and this package keeps a very small
 * dependency tree.
 */
export class ApiClient {
  constructor(private readonly options: ClientOptions) {}

  get<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, body);
  }

  delete<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const url = `${this.options.baseURL}/api/v1${path}`;

    // A blocking start can legitimately take beforeStartTimeout + startTimeout +
    // afterStartTimeout (~130s with the defaults), so start-like commands pass
    // timeoutMs: 0 and wait indefinitely rather than report a false failure.
    const controller = new AbortController();
    const timer =
      this.options.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.options.timeoutMs)
        : undefined;

    let response: Response;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      // Every mutating request must be application/json — the server requires
      // it as a CSRF guard, and rejects anything else with 415.
      if (method === "POST") headers["Content-Type"] = "application/json";

      response = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `Timed out after ${this.options.timeoutMs}ms waiting for ${this.options.baseURL}`
          : `Could not reach a dashboard at ${this.options.baseURL} (${
              err instanceof Error ? err.message : String(err)
            })`;
      return { kind: "unreachable", message };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return {
        kind: "unexpected",
        message: `Expected JSON from ${url} but got: ${text.slice(0, 200)}`,
      };
    }

    if (response.ok) {
      return { kind: "ok", status: response.status, data: parsed as T };
    }

    const error = (parsed as { error?: ApiError }).error;
    if (!error?.code) {
      return {
        kind: "unexpected",
        message: `HTTP ${response.status} from ${url} with no error code.`,
      };
    }

    return { kind: "api", status: response.status, error };
  }

  /** Fetches raw text (used for `logs --text`, which the server renders as text/plain). */
  async getText(path: string): Promise<ApiResult<string>> {
    const url = `${this.options.baseURL}/api/v1${path}`;
    try {
      const response = await fetch(url, { headers: { Accept: "text/plain" } });
      const text = await response.text();

      if (!response.ok) {
        try {
          const error = (JSON.parse(text) as { error?: ApiError }).error;
          if (error?.code)
            return { kind: "api", status: response.status, error };
        } catch {
          // fall through to the generic message below
        }
        return {
          kind: "unexpected",
          message: `HTTP ${response.status} from ${url}`,
        };
      }

      return { kind: "ok", status: response.status, data: text };
    } catch (err) {
      return {
        kind: "unreachable",
        message: `Could not reach a dashboard at ${this.options.baseURL} (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
  }
}
