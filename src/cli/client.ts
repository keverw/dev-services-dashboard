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
  | { kind: "unexpected"; message: string }
  // Its own arm rather than an `unreachable`: the dashboard was fine, the user
  // pressed Ctrl+C. Reporting it as "couldn't reach the dashboard" would tell a
  // script exactly the wrong thing.
  | { kind: "interrupted"; message: string };

/**
 * Maps an API failure code onto the process exit code it should produce.
 *
 * The `default` arm is load-bearing, not defensive padding: `request()` accepts
 * any error envelope carrying a truthy `code`, and this CLI is installed as a
 * global `bin` while the dashboard it drives is a project-local library, so a
 * newer dashboard (or a proxy with its own error shape) can hand back a code
 * this build has never heard of. Without the fallback the switch would return
 * `undefined`, which rides all the way to `process.exitCode` and exits 0,
 * reporting a failure as success to `dsd start api && deploy`.
 */
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
    // A code this build doesn't know, which only happens at runtime. Adding a
    // `default` arm makes every path return, which by itself would silently
    // retire the compile-time exhaustiveness check (that was the implicit
    // "function lacks ending return statement" error, and it can only fire
    // while the end of the switch is reachable). Assigning to `never` restores
    // it: add a member to `ApiErrorCode` without an arm above and this line
    // stops compiling.
    default: {
      const unhandled: never = code;
      void unhandled;
      return EXIT.UNEXPECTED;
    }
  }
}

/** Reported when the user interrupts a request (Ctrl+C) rather than it failing. */
export const INTERRUPTED = "Interrupted.";

export interface ClientOptions {
  baseURL: string;
  /** Milliseconds before giving up; 0 (the default for start-like commands) waits forever. */
  timeoutMs: number;
  /**
   * Cancels an in-flight request. `bin.ts` wires this to Ctrl+C, so a command
   * with no client deadline (a blocking `start`, or a `stop` waiting out a long
   * grace period) can still be interrupted on the first press rather than
   * running to completion with the signal handler swallowing the terminate.
   */
  signal?: AbortSignal;
}

/**
 * Minimal fetch wrapper over the control API.
 *
 * Uses only globals and `node:` builtins on purpose: the CLI must not pull
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

    // Checked before arming the timer below, so bailing out here can't leave a
    // pending timeout holding the event loop open.
    const interrupt = this.options.signal;
    if (interrupt?.aborted)
      return { kind: "interrupted", message: INTERRUPTED };

    // A blocking start can legitimately take beforeStartTimeout + startTimeout +
    // afterStartTimeout (~130s with the defaults), so start-like commands pass
    // timeoutMs: 0 and wait indefinitely rather than report a false failure.
    const controller = new AbortController();
    const timer =
      this.options.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.options.timeoutMs)
        : undefined;

    const onInterrupt = () => controller.abort();
    interrupt?.addEventListener("abort", onInterrupt);

    let response: Response;
    let text: string;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      // Every mutating request must be application/json, since the server requires
      // it as a CSRF guard, and rejects anything else with 415.
      if (method === "POST") headers["Content-Type"] = "application/json";

      response = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });

      // Read the body inside the same try, so the deadline and the interrupt
      // still apply. `fetch` resolves as soon as the headers arrive, so a
      // response that stalls mid-body would otherwise hang past --timeout.
      text = await response.text();
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && interrupt?.aborted) {
        return { kind: "interrupted", message: INTERRUPTED };
      }
      const message = aborted
        ? `Timed out after ${this.options.timeoutMs}ms waiting for ${this.options.baseURL}`
        : `Could not reach a dashboard at ${this.options.baseURL} (${
            err instanceof Error ? err.message : String(err)
          })`;
      return { kind: "unreachable", message };
    } finally {
      if (timer) clearTimeout(timer);
      interrupt?.removeEventListener("abort", onInterrupt);
    }

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
}
