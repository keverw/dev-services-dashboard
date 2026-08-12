import { spawn } from "child_process";
import { constants } from "os";
import { Service, UserServiceConfig } from "./types";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import { Logger } from "./logger";

/**
 * Why a `sendSignal` call did or didn't deliver. The signal path refuses for
 * several distinct reasons that all used to be indistinguishable to a caller
 * (they were recorded only in the service's log stream), but which the HTTP
 * control API has to tell apart to pick a status code: an undeclared signal is
 * a caller mistake (422) while a stopped service is a state conflict (409).
 */
export type SendSignalResult =
  | "sent"
  | "service_not_found"
  | "not_running"
  | "not_declared"
  | "unknown_signal"
  | "send_failed";

/** Outcome of a "Start All" run. `ran: false` means it was declined outright. */
export interface StartAllSummary {
  /**
   * False when the run never began, either because the dashboard is shutting
   * down or because another Start All is already in flight. Distinguishing this
   * from a run that started nothing matters: `{started: 0}` alone reads as
   * "everything failed".
   */
  ran: boolean;
  started: number;
  failed: number;
  skipped: number;
  total: number;
}

/** Outcome of a "Stop All" run. */
export interface StopAllSummary {
  stopped: number;
  failed: number;
  total: number;
}

/**
 * Strips ANSI escape sequences from a log line. The UI renders logs as plain
 * text, so any escape sequence is just noise (or, for cursor moves / erases,
 * visible garbage). Covers:
 *   - CSI sequences (`ESC [ … <final byte>`): this is SGR color/style **and**
 *     cursor moves, clear-line / clear-screen, etc. (e.g. progress spinners).
 *   - OSC sequences (`ESC ] … BEL` or `ESC ] … ESC \`): e.g. window-title sets.
 * Requiring the leading ESC (`\x1b`) means we consume whole sequences and never
 * clobber legitimate text that merely looks like a code (e.g. "arr[0m]").
 * Exported for testing.
 */
export function stripAnsi(input: string): string {
  // OSC: ESC ] … terminated by BEL (\x07) or ST (ESC \). CSI: ESC [ then
  // parameter bytes (0x30–0x3F), intermediate bytes (0x20–0x2F), and a final
  // byte (0x40–0x7E), which covers SGR (`m`) along with cursor/erase codes.
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g,
    "",
  );
}

/**
 * Parses `ps -A -o pid=,ppid=` output into a parent-pid → child-pids map.
 * Exported for testing.
 */
export function parsePsOutput(output: string): Map<number, number[]> {
  const parentToChildren = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const children = parentToChildren.get(ppid) ?? [];
    children.push(pid);
    parentToChildren.set(ppid, children);
  }
  return parentToChildren;
}

/**
 * Collects all descendant pids of `rootPid` from a parent → children map
 * (breadth-first). Exported for testing.
 */
export function collectDescendants(
  rootPid: number,
  parentToChildren: Map<number, number[]>,
): number[] {
  const result: number[] = [];
  const queue = [...(parentToChildren.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue; // guard against pid cycles in malformed input
    seen.add(pid);
    result.push(pid);
    const children = parentToChildren.get(pid);
    if (children) queue.push(...children);
  }
  return result;
}

/**
 * Numeric-option guard for the whole package. Returns `value` only when it is a
 * finite number greater than zero; otherwise falls back to `fallback`. This is
 * what makes every numeric option (port, maxLogLines, the timeouts) treat `0`,
 * negatives, NaN, and non-finite values alike as "unset", so a bogus input
 * can't silently disable the log buffer or collapse a timeout to an immediate
 * 0ms deadline. Exported for testing.
 */
export function positiveOr(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * The largest delay `setTimeout` can hold, since it stores the delay in a
 * 32-bit signed integer. Anything above this is silently clamped to 1ms by
 * Node (with a TimeoutOverflowWarning), which would turn "wait a very long
 * time" into "fire on the next tick", the exact opposite of what was asked.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Caps a timer delay at what `setTimeout` can actually represent. Used on the
 * stop grace period, whose value can come from a caller (a `graceMs` override
 * over HTTP or the WebSocket) rather than only from the dashboard's own config.
 */
export function clampTimerMs(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}

/**
 * String-option guard mirroring `positiveOr` for string options (e.g.
 * `hostname`). Returns the trimmed value when it's a non-empty string,
 * otherwise the `fallback`, so a non-string, empty, or whitespace-only value
 * falls back to the default. Trimming also drops stray surrounding whitespace
 * that would otherwise make an address fail to bind. Exported for testing.
 */
export function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

// Reason used when a service's own process exits/crashes while its `afterStart`
// hook is still running, so we abort the hook's AbortController (letting a
// readiness hook that polls the process give up). It's distinguished from a
// stop-driven abort (default reason) so a throwing afterStart still settles the
// service on `error` rather than being treated as an intentional stop.
const HOOK_ABORT_PROCESS_EXIT = "process-exited";

export class ServiceManager {
  private services: Service[] = [];
  private maxLogLines: number;
  private broadcastFn: (message: ServerMessage) => void;
  private logger: Logger;
  // AbortControllers for services currently running a lifecycle hook
  // (beforeStart or afterStart). Aborted when the service is stopped mid-hook,
  // or (for afterStart) when the process exits on its own under the hook.
  private abortControllers = new Map<string, AbortController>();
  // On POSIX, services are spawned detached so each leads its own process
  // group, letting us signal the whole group (the spawned wrapper plus any
  // children it forked) on stop. Windows has no equivalent, so we signal just
  // the process there.
  private readonly useProcessGroups = process.platform !== "win32";
  // Default time (ms) to wait after SIGTERM before escalating to SIGKILL.
  private readonly defaultStopTimeout: number;
  // "Start All" wait windows: `startTimeout` for reaching `running` after
  // spawning, `beforeStartTimeout` for the `initializing`/`beforeStart` phase.
  private readonly startTimeout: number;
  private readonly beforeStartTimeout: number;
  private readonly afterStartTimeout: number;
  // One-shot listeners that "Start All" registers per service to be notified
  // (via setStatus) when the service it's waiting on changes status.
  private startWaiters = new Map<string, (status: Service["status"]) => void>();
  // Service IDs whose log buffer has actually evicted a line. Buffer *length*
  // can't answer that on its own: `addLog` only evicts once the push takes it
  // past `maxLogLines`, so a full-but-never-evicted buffer sits at exactly the
  // cap and is indistinguishable from one that has been dropping lines. The
  // control API reports this as `truncated`, which a `since`-based poller uses
  // to decide whether it may have missed lines.
  private evictedLogs = new Set<string>();
  // The `seq` the next log entry will carry. Dashboard-wide rather than
  // per-service, so one counter orders every buffer, and deliberately never
  // reset: clearing a buffer must not hand a later entry a number an earlier
  // one already used, or a poller holding the old cursor would skip it.
  private nextLogSeq = 1;
  // In-flight `startAndWait` runs, keyed by serviceID. A second concurrent
  // start of the same service attaches to the existing run's promise rather
  // than spawning a second waiter+timer (only one waiter can live in
  // `startWaiters` per service, so two runs would orphan the first's timer,
  // which could later fire `failStartOnTimeout` against an already-`running`
  // service and wrongly tear it down).
  private inFlightStarts = new Map<string, Promise<boolean>>();
  // In-flight `stopService` runs, keyed by serviceID. Held so a *forced* stop
  // arriving while a graceful one is still waiting out its `stopTimeout` can
  // escalate that run to SIGKILL immediately and share its promise, instead of
  // starting a second stop, which would detach the first run's `exit` listener
  // and leave its caller awaiting a promise that never settles.
  private inFlightStops = new Map<
    string,
    {
      promise: Promise<void>;
      escalate: () => void;
      /** Re-arms the grace period of a stop already under way (see `graceMs`). */
      retime: (graceMs: number) => void;
      /**
       * When the currently-armed grace period expires, on `performance.now()`'s
       * monotonic clock, or 0 if none is armed. Read by `stopGraceEndsAt`.
       */
      graceEndsAt: () => number;
    }
  >();
  private startAllInProgress = false;
  // Latched true when the dashboard server begins shutting down (DevUIServer
  // stop()). Once set, every start path refuses, so neither a late client
  // action nor an in-flight `startAndWait` waiter can resurrect a service after
  // shutdown has already stopped it. A resurrected process would leak, since
  // the closing server no longer manages it. Stop paths are unaffected (the
  // shutdown itself drives them through stopService/stopAllServices).
  //
  // This is terminal and never cleared: stop() closes the server, so this
  // ServiceManager instance is done. Running again means a fresh
  // startDevServicesDashboard() call, which builds a new ServiceManager with
  // shuttingDown = false.
  private shuttingDown = false;

  constructor(
    logger: Logger,
    userServices: UserServiceConfig[],
    maxLogLines: number,
    broadcastFn: (message: ServerMessage) => void,
    defaultCwd: string | undefined,
    options: {
      stopTimeout?: number;
      startTimeout?: number;
      beforeStartTimeout?: number;
      afterStartTimeout?: number;
    } = {},
  ) {
    this.maxLogLines = maxLogLines;
    this.broadcastFn = broadcastFn;
    this.logger = logger;
    // `positiveOr` (not `??`/`||`) so `0`, negatives, and non-finite values all
    // fall back to the default, consistent with how `port` / `maxLogLines` are
    // handled. A non-positive timeout would be meaningless (immediate SIGKILL /
    // a 0ms start deadline), so we treat anything ≤ 0 as "unset".
    this.defaultStopTimeout = positiveOr(options.stopTimeout, 5000);
    this.startTimeout = positiveOr(options.startTimeout, 10000);
    this.beforeStartTimeout = positiveOr(options.beforeStartTimeout, 60000);
    this.afterStartTimeout = positiveOr(options.afterStartTimeout, 60000);

    // Convert user service configs to full service objects
    this.services = userServices.map((userService) => ({
      id: userService.id,
      name: userService.name,
      command: userService.command,
      cwd: userService.cwd || defaultCwd || process.cwd(),
      env: userService.env,
      webLinks: userService.webLinks,
      signals: userService.signals,
      dependsOn: userService.dependsOn,
      beforeStart: userService.beforeStart,
      afterStart: userService.afterStart,
      gracefulShutdown: userService.gracefulShutdown,
      stopTimeout: userService.stopTimeout,
      process: null,
      status: "stopped",
      logs: [],
      errorDetails: null,
    }));

    // Reorder services so dependencies start before their dependents.
    this.computeStartOrder();
  }

  /**
   * Topologically sorts `this.services` based on the `dependsOn` graph so that
   * dependencies appear before the services that depend on them. Unknown
   * dependency IDs are dropped with a warning. Self-dependencies and dependency
   * cycles are unresolvable misconfigurations and throw: the dashboard refuses
   * to start rather than run in a misleading order.
   */
  private computeStartOrder(): void {
    // Validate the basic config up front. IDs must be unique (they key every
    // lookup, `dependsOn` reference, and the per-service UI, so a duplicate would
    // silently shadow the earlier service), and each `command` must be a
    // non-empty string array whose first element (the executable) is a
    // non-empty string. We reject these here rather than fail obscurely later.
    const idSet = new Set<string>();
    for (const service of this.services) {
      if (idSet.has(service.id)) {
        throw new Error(
          `Invalid service configuration: duplicate service id "${service.id}".`,
        );
      }
      idSet.add(service.id);

      if (
        !Array.isArray(service.command) ||
        service.command.length === 0 ||
        typeof service.command[0] !== "string" ||
        service.command[0].length === 0
      ) {
        throw new Error(
          `Invalid service configuration: "${service.id}" has an empty or invalid command (expected a non-empty string[] whose first element is the executable).`,
        );
      }
    }

    // Sanitize dependsOn: reject self-dependencies, drop unknown service IDs.
    for (const service of this.services) {
      if (!service.dependsOn) continue;

      if (service.dependsOn.includes(service.id)) {
        throw new Error(
          `Invalid service configuration: "${service.id}" cannot depend on itself.`,
        );
      }

      service.dependsOn = service.dependsOn.filter((dep) => {
        if (idSet.has(dep)) return true;
        this.logger.warn(
          `Service "${service.id}" dependsOn unknown service "${dep}"; ignoring.`,
        );
        return false;
      });
    }

    const byId = new Map(this.services.map((s) => [s.id, s]));
    const sorted: Service[] = [];
    const visited = new Set<string>(); // permanently placed
    const inStack = new Set<string>(); // current DFS path (cycle detection)
    const path: string[] = []; // ordered DFS path, for cycle reporting

    const visit = (service: Service) => {
      if (visited.has(service.id)) return;
      if (inStack.has(service.id)) {
        const cycle = [...path.slice(path.indexOf(service.id)), service.id];
        throw new Error(
          `Invalid service configuration: dependency cycle detected (${cycle.join(
            " -> ",
          )}).`,
        );
      }
      inStack.add(service.id);
      path.push(service.id);
      for (const depId of service.dependsOn ?? []) {
        const dep = byId.get(depId);
        if (dep) visit(dep);
      }
      path.pop();
      inStack.delete(service.id);
      visited.add(service.id);
      sorted.push(service);
    };

    for (const service of this.services) {
      visit(service);
    }

    this.services = sorted;
  }

  getServices(): Service[] {
    return this.services;
  }

  /**
   * The configured per-service log buffer cap. Exposed so the control API can
   * report it alongside a logs response: once the buffer is at this size, older
   * lines have been evicted, which a timestamp-based poller needs to know.
   */
  getMaxLogLines(): number {
    return this.maxLogLines;
  }

  /**
   * Whether this service's log buffer has actually dropped an older line yet.
   * A buffer sitting at exactly `maxLogLines` has not: `addLog` evicts only
   * once a push takes it *past* the cap, so length alone would report a gap one
   * entry before there is one.
   */
  hasEvictedLogs(serviceID: string): boolean {
    return this.evictedLogs.has(serviceID);
  }

  /**
   * Latches the manager into shutdown so every start/restart/start-all path
   * refuses from here on. Called by the dashboard server's `stop()` before it
   * stops the services, so nothing can resurrect a service mid-shutdown.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Whether `beginShutdown` has been called (the server is stopping). */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  getService(serviceID: string): Service | undefined {
    return this.services.find((s) => s.id === serviceID);
  }

  addLog(
    serviceID: string,
    originalLine: string,
    logType: LogEntry["logType"] = "stdout",
  ) {
    const service = this.getService(serviceID);
    if (!service) return;

    // Strip ANSI escape sequences: the UI renders logs as plain text, so
    // they'd just be noise (see stripAnsi for what's covered).
    const line = stripAnsi(originalLine);

    const logEntry: LogEntry = {
      seq: this.nextLogSeq++,
      timestamp: Date.now(),
      line,
      logType,
    };
    service.logs.push(logEntry);
    if (service.logs.length > this.maxLogLines) {
      service.logs.shift();
      this.evictedLogs.add(serviceID);
    }
    this.broadcastLog(
      serviceID,
      line,
      logType,
      logEntry.timestamp,
      logEntry.seq,
    );
  }

  private broadcastLog(
    serviceID: string,
    line: string,
    logType: LogEntry["logType"],
    timestamp: number,
    seq: number,
  ) {
    this.broadcastFn({ type: "log", serviceID, line, logType, timestamp, seq });
  }

  /**
   * The single status-transition point. Writes the service's `status` and
   * `errorDetails`, broadcasts the change to clients, reverts dynamic web links
   * when the service is no longer up, and notifies any `startAndWait` waiter.
   *
   * Every status change goes through here, so callers never assign
   * `service.status` themselves. They call `setStatus`.
   *
   * The waiter is notified **asynchronously** (on a microtask), never inline.
   * This is load-bearing: a waiter reacts to `stopped` by starting a fresh
   * process, and if that ran synchronously it would execute in the middle of
   * the emitter's own work (e.g. an exit handler that still has to null the
   * process handle and reap the old process group), corrupting it (a clobbered
   * handle, a port race). Deferring guarantees the emitter finishes its
   * synchronous teardown before any waiter runs, so no emitter has to order its
   * cleanup around re-entrant restarts.
   */
  private setStatus(
    serviceID: string,
    status: Service["status"],
    errorDetails: string | null = null,
  ): void {
    const service = this.getService(serviceID);
    if (service) {
      service.status = status;
      service.errorDetails = errorDetails;
    }
    this.broadcastFn({
      type: "status_update",
      serviceID,
      status,
      errorDetails,
    });

    // Once a service is no longer up, drop any links its hooks computed for the
    // run (a tunnel URL, a dynamically-chosen port) and revert the card to the
    // configured baseline: a dead service shouldn't show a stale dynamic link.
    // No-op (and no broadcast) when it had no live links to begin with.
    if (
      service &&
      service.liveWebLinks !== undefined &&
      (status === "stopped" || status === "crashed" || status === "error")
    ) {
      service.liveWebLinks = undefined;
      this.broadcastFn({
        type: "links_update",
        serviceID,
        webLinks: service.webLinks ?? [],
      });
    }

    // Notify the start waiter asynchronously (see the doc comment). Capture the
    // current waiter so a later-registered one can't receive this now-stale
    // status; the waiter itself also ignores calls once it has settled.
    const waiter = this.startWaiters.get(serviceID);
    if (waiter) queueMicrotask(() => waiter(status));
  }

  async startService(serviceID: string) {
    // The server is shutting down; never spawn (or respawn, via a waiter) a
    // service that the shutdown has stopped or is about to stop.
    if (this.shuttingDown) return;

    const service = this.getService(serviceID);
    if (
      !service ||
      (service.status !== "stopped" &&
        service.status !== "error" &&
        service.status !== "crashed")
    ) {
      this.logger.warn(
        `Service ${service?.name} is ${service?.status}, cannot start.`,
      );
      return;
    }

    this.logger.info(`Starting service: ${service.name}...`);
    service.errorDetails = null;

    // Start each run from the configured baseline so hook-returned links don't
    // accumulate across restarts: beforeStart sees the baseline and may replace
    // the live set, then afterStart sees that live set and may replace it again.
    service.liveWebLinks = undefined;

    let mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...service.env,
    };

    // Run the optional pre-start hook before spawning the process.
    if (service.beforeStart) {
      this.setStatus(serviceID, "initializing");
      this.addLog(
        serviceID,
        `Running pre-start hook for ${service.name}...`,
        "system",
      );

      const controller = new AbortController();
      this.abortControllers.set(serviceID, controller);

      // Only clear the map entry if it's still ours: if the service was stopped
      // and started again while a signal-ignoring hook was still settling, a
      // newer start may have replaced this controller, and we must not evict it.
      const clearOwnController = () => {
        if (this.abortControllers.get(serviceID) === controller) {
          this.abortControllers.delete(serviceID);
        }
      };

      try {
        const result = await service.beforeStart({
          env: mergedEnv,
          // Always the configured baseline (a copy), so the hook can't see
          // (and accumulate on top of) links it added on a previous run.
          webLinks: [...(service.webLinks ?? [])],
          log: (line: string) => this.addLog(serviceID, line, "system"),
          signal: controller.signal,
        });

        // If the user stopped the service while the hook ran, stopService has
        // already transitioned it to "stopped"; just bail out.
        if (controller.signal.aborted) {
          clearOwnController();
          return;
        }

        // Apply any env / web link overrides the hook returned. Links go into
        // `liveWebLinks` (display) rather than overwriting the configured
        // baseline `webLinks`.
        if (result?.env) mergedEnv = result.env;
        if (result?.webLinks) {
          service.liveWebLinks = result.webLinks;
          this.broadcastFn({
            type: "links_update",
            serviceID,
            webLinks: result.webLinks,
          });
        }
      } catch (err) {
        clearOwnController();
        // An abort during the hook is an intentional stop, not an error.
        if (controller.signal.aborted) return;

        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Pre-start hook failed for ${service.name}:`,
          err as object,
        );
        this.addLog(serviceID, `Pre-start hook failed: ${message}`, "system");
        this.setStatus(serviceID, "error", message);
        return;
      }

      clearOwnController();
    }

    this.setStatus(serviceID, "starting");
    this.addLog(serviceID, `Attempting to start ${service.name}...`, "system");

    try {
      service.process = spawn(service.command[0], service.command.slice(1), {
        cwd: service.cwd,
        env: mergedEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // Detach so the child leads its own process group (POSIX), enabling
        // group-wide termination on stop. We keep the reference (no unref).
        detached: this.useProcessGroups,
      });

      service.process.on("spawn", () => {
        this.logger.info(
          `Service ${service.name} started (PID: ${service.process?.pid}).`,
        );

        // If the service was stopped during the brief `starting` window (after
        // spawn() returned but before this event fired (e.g. Stop All targets a
        // `starting` service), the stop path now owns it: it has set `stopping`
        // and is tearing the process down. Don't promote it to `running` (or
        // kick off afterStart against a process being SIGTERM'd) out from under
        // the stop. The normal path is always `starting` here.
        if (service.status !== "starting") return;

        // If there's a post-start hook, run it as a readiness gate before
        // reporting `running`; otherwise the process being up is enough.
        if (service.afterStart) {
          void this.runAfterStart(serviceID, mergedEnv);
        } else {
          this.addLog(
            serviceID,
            `${service.name} started successfully.`,
            "system",
          );
          this.setStatus(serviceID, "running");
        }
      });

      service.process.stdout?.on("data", (data: Buffer) =>
        this.addLog(serviceID, data.toString(), "stdout"),
      );
      service.process.stderr?.on("data", (data: Buffer) =>
        this.addLog(serviceID, data.toString(), "stderr"),
      );

      service.process.on("error", (err) => {
        this.logger.error(`Failed to start service ${service.name}:`, err);
        this.addLog(
          serviceID,
          `Error starting ${service.name}: ${err.message}`,
          "system",
        );
        service.process = null;
        this.setStatus(serviceID, "error", err.message);
      });

      service.process.on("exit", (code, signal) => {
        const wasStopping = service.status === "stopping";

        // If an afterStart hook is still running when the process dies on its
        // own, abort its signal so a readiness hook polling the (now dead)
        // process can give up. The exit reason keeps this distinct from a stop
        // so a throwing hook still settles on `error` (see runAfterStart).
        this.abortControllers.get(serviceID)?.abort(HOOK_ABORT_PROCESS_EXIT);

        // Determine exit type and status
        let newStatus: Service["status"];
        let exitType: string;
        let errorDetails: string | null = null;

        if (wasStopping) {
          // Intentional stop
          newStatus = "stopped";
          exitType = "clean shutdown";
        } else if (code === 0) {
          // Clean exit
          newStatus = "stopped";
          exitType = "clean exit";
        } else if (signal === "SIGTERM" || signal === "SIGINT") {
          // Terminated by signal (but not by us)
          newStatus = "stopped";
          exitType = "terminated by signal";
          errorDetails = `Terminated by ${signal}`;
        } else if (signal === "SIGKILL") {
          // Force killed
          newStatus = "crashed";
          exitType = "force killed";
          errorDetails = `Process was force killed (SIGKILL)`;
        } else if (signal) {
          // Other signals (crashes)
          newStatus = "crashed";
          exitType = "crashed";
          errorDetails = `Process crashed with signal ${signal}`;
        } else if (code && code > 0) {
          // Non-zero exit code
          if (code === 1) {
            newStatus = "error";
            exitType = "error";
            errorDetails = `Exited with error code ${code} (general error)`;
          } else if (code >= 128) {
            newStatus = "crashed";
            exitType = "crashed";
            errorDetails = `Process crashed with exit code ${code}`;
          } else {
            newStatus = "error";
            exitType = "error";
            errorDetails = `Exited with error code ${code}`;
          }
        } else {
          newStatus = "error";
          exitType = "unexpected exit";
          errorDetails = `Unexpected exit (code: ${code}, signal: ${signal})`;
        }

        const exitMessage = `Service ${service.name} ${exitType} (code ${code}, signal ${signal}).`;
        const logLevel = newStatus === "stopped" ? "info" : "error";

        if (logLevel === "info") {
          this.logger.info(exitMessage);
        } else {
          this.logger.error(exitMessage);
        }
        this.addLog(serviceID, exitMessage, "system");
        // Clear the handle before the transition so the broadcast reflects a
        // fully-dead service. (Waiter notification is async, so this ordering
        // is just for a consistent snapshot, not correctness.)
        service.process = null;
        this.setStatus(serviceID, newStatus, errorDetails);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Exception starting service ${service.name}:`,
        err as object,
      );
      this.addLog(
        serviceID,
        `Exception starting ${service.name}: ${message}`,
        "system",
      );
      service.process = null;
      this.setStatus(serviceID, "error", message);
    }
  }

  /**
   * Runs a service's `afterStart` hook after its process has spawned, while the
   * service sits in the `finalizing` state. On success the service is promoted
   * to `running`; if the hook throws, the just-started process is torn down and
   * the service goes to `error` (so "Start All" skips its dependents). An abort
   * (the user stopped the service mid-hook) is handled by `stopService` and we
   * simply bail without overriding the status it set.
   */
  private async runAfterStart(
    serviceID: string,
    mergedEnv: Record<string, string>,
  ): Promise<void> {
    const service = this.getService(serviceID);
    if (!service || !service.afterStart || !service.process) return;

    this.addLog(
      serviceID,
      `Running post-start hook for ${service.name}...`,
      "system",
    );
    this.setStatus(serviceID, "finalizing");

    const controller = new AbortController();
    this.abortControllers.set(serviceID, controller);
    const clearOwnController = () => {
      if (this.abortControllers.get(serviceID) === controller) {
        this.abortControllers.delete(serviceID);
      }
    };

    try {
      const result = await service.afterStart({
        env: mergedEnv,
        pid: service.process.pid,
        // The current live links: what beforeStart returned this run, or the
        // configured baseline if there was no beforeStart. So afterStart can
        // build on (`[...webLinks, x]`) rather than clobber beforeStart's links.
        webLinks: [...(service.liveWebLinks ?? service.webLinks ?? [])],
        log: (line: string) => this.addLog(serviceID, line, "system"),
        signal: controller.signal,
      });

      // The hook was aborted (the user stopped the service, or the process
      // exited under it): something else already set the terminal status, so
      // don't promote to running or apply links. (The status check below also
      // covers the process-exit case; this also covers an abort the hook
      // swallowed without its status having changed yet.)
      if (controller.signal.aborted) {
        clearOwnController();
        return;
      }

      clearOwnController();

      // If the process exited on its own while the hook ran (a crash or clean
      // exit), the exit handler has already set a terminal status and reverted
      // the links: don't apply the hook's results or promote to running, or a
      // dead service would show stale dynamic links.
      if (service.status !== "finalizing") return;

      if (result?.webLinks) {
        service.liveWebLinks = result.webLinks;
        this.broadcastFn({
          type: "links_update",
          serviceID,
          webLinks: result.webLinks,
        });
      }

      this.addLog(serviceID, `${service.name} started successfully.`, "system");
      this.setStatus(serviceID, "running");
    } catch (err) {
      // If a newer start has replaced our controller, this run is stale (the
      // service was stopped/restarted while a signal-ignoring hook kept
      // running): it must not touch the service the current run now owns.
      // Capture before clearOwnController, which would drop our own entry.
      const superseded = this.abortControllers.get(serviceID) !== controller;
      clearOwnController();

      // A stop-driven abort is an intentional stop, not a failure, so bail;
      // stopService already set the status. An exit-driven abort (the process
      // died under the hook) is NOT a clean stop: fall through so a thrown hook
      // still settles the service on `error`, but only while we're still the
      // current run.
      if (
        superseded ||
        (controller.signal.aborted &&
          controller.signal.reason !== HOOK_ABORT_PROCESS_EXIT)
      )
        return;

      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Post-start hook failed for ${service.name}:`,
        err as object,
      );
      this.addLog(serviceID, `Post-start hook failed: ${message}`, "system");
      if (service.process) {
        // The process is live and holding ports, so tear it (and its group) down,
        // then settle on `error`. stopService reuses the full kill machinery and
        // applies the final status we ask for once the process has exited.
        await this.stopService(serviceID, {
          finalStatus: "error",
          errorDetails: message,
        });
      } else {
        // The process already exited on its own during the hook (e.g. a clean
        // exit that left the service `stopped`). The hook still failed, so make
        // that authoritative: a thrown afterStart is a failed start (`error`),
        // which Start All treats as a failure and uses to skip dependents.
        this.setStatus(serviceID, "error", message);
      }
    }
  }

  /**
   * Sends a POSIX signal to a running service process. The signal must both be
   * declared in the service's `signals[]` config AND be a known signal name
   * (validated against `os.constants.signals`). A signal the service didn't
   * declare is refused even if it's otherwise valid: `signals[]` is the
   * allow-list, so a raw WebSocket client can't send arbitrary signals the
   * config never opted into. No-op if the service is not currently running.
   *
   * Unlike stop (which signals the whole process group), this targets ONLY the
   * launched command's main process, by design. Custom signals like `SIGHUP`
   * (reload config) are meant for the process you configured, not blasted at
   * every child it forked. Note the consequence: if your `command` is a wrapper
   * that does not forward signals (e.g. `bun run …`, `vite`, `nodemon`), the
   * signal reaches the wrapper, not the underlying dev server it spawned. If you
   * need the inner process to receive it, run that process directly (or have the
   * wrapper forward signals).
   *
   * Returns why the call did or didn't deliver (see `SendSignalResult`). Every
   * refusal is still logged and written to the service's log stream exactly as
   * before; the return value just makes the reason available to callers that
   * need to act on it (the HTTP control API maps it to a status code).
   */
  sendSignal(serviceID: string, signal: string): SendSignalResult {
    const service = this.getService(serviceID);
    if (!service) return "service_not_found";

    if (service.status !== "running" || !service.process) {
      this.logger.warn(
        `Cannot send ${signal} to ${service.name}: service is ${service.status}.`,
      );

      this.addLog(
        serviceID,
        `Refused to send "${signal}": service is ${service.status}, not running.`,
        "system",
      );

      return "not_running";
    }

    // Only signals the service explicitly declared may be sent. The UI only
    // surfaces these, but this also stops a raw WebSocket client from sending a
    // valid-but-undeclared signal the config never opted into.
    if (!service.signals?.some((s) => s.signal === signal)) {
      this.logger.warn(
        `Refusing to send undeclared signal "${signal}" to ${service.name}.`,
      );
      this.addLog(
        serviceID,
        `Refused to send undeclared signal "${signal}".`,
        "system",
      );
      return "not_declared";
    }

    // Use hasOwnProperty (not `in`) so inherited Object.prototype names like
    // "toString"/"constructor" don't pass as valid signals.
    if (!Object.prototype.hasOwnProperty.call(constants.signals, signal)) {
      this.logger.warn(
        `Refusing to send unknown signal "${signal}" to ${service.name}.`,
      );
      this.addLog(
        serviceID,
        `Refused to send unknown signal "${signal}".`,
        "system",
      );
      return "unknown_signal";
    }

    try {
      service.process.kill(signal as NodeJS.Signals);
      this.logger.info(`Sent ${signal} to ${service.name}.`);
      this.addLog(serviceID, `Sent ${signal} to ${service.name}.`, "system");
      return "sent";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send ${signal} to ${service.name}:`,
        err as object,
      );
      this.addLog(serviceID, `Failed to send ${signal}: ${message}`, "system");
      return "send_failed";
    }
  }

  /**
   * Sends a termination signal to a service's process. On POSIX the process was
   * spawned detached (its own process group), so `targetGroup` signals the
   * whole group via a negative PID, reaching children the process forked (e.g.
   * a `bun run` / `vite` wrapper) that would otherwise be orphaned and keep
   * ports held. With `targetGroup` false (graceful stop), only the main process
   * is signaled, letting it coordinate its own children. Falls back to
   * signaling just the process if the group signal fails or process groups
   * aren't available (Windows).
   */
  private stopSignal(
    service: Service,
    signal: NodeJS.Signals,
    targetGroup: boolean,
  ): void {
    const proc = service.process;
    if (!proc || proc.pid === undefined) return;

    if (targetGroup && this.useProcessGroups) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {
        // Group already gone or signal not permitted, so fall back below.
      }
    }

    try {
      proc.kill(signal);
    } catch {
      // Process already exited.
    }
  }

  /**
   * Best-effort fallback for force-kill: walks the live descendant tree of the
   * given pid (via `ps`) and SIGKILLs anything still alive. This catches
   * children that escaped the process group (e.g. via `setsid`) and so weren't
   * reached by the group signal. POSIX-only and called while the parent is
   * still alive, so the pids are current (no stale-pid reuse risk). Children
   * that fully daemonized (double-fork, reparented to init) are not tracked.
   *
   * Runs `ps` asynchronously so it never blocks the event loop; resolves once
   * the walk + kills are done (or is skipped on Windows / if `ps` is missing).
   *
   * This is a single pass, with no retry. SIGKILL is uncatchable, so anything the
   * walk finds will die; re-walking would only chase a vanishingly rare process
   * spawned in the window between the snapshot and the kills (and an in-group
   * one would be caught by the group SIGKILL anyway). If `ps` fails, the group
   * SIGKILL remains the fallback.
   */
  private reapEscapedDescendants(pid: number | undefined): Promise<void> {
    if (pid === undefined || !this.useProcessGroups) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      let child;
      try {
        child = spawn("ps", ["-A", "-o", "pid=,ppid="], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        finish(); // ps unavailable, group kill was our best effort
        return;
      }

      // Don't let a hung/slow `ps` block the force-kill.
      const guard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }

        finish();
      }, 2000);

      let output = "";
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });

      child.on("error", () => {
        clearTimeout(guard);
        finish();
      });

      child.on("close", (code) => {
        clearTimeout(guard);

        if (code === 0) {
          for (const childPid of collectDescendants(
            pid,
            parsePsOutput(output),
          )) {
            try {
              process.kill(childPid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
        finish();
      });
    });
  }

  /**
   * Stops a running service. `opts.finalStatus` lets an internal caller settle
   * the service on a status other than `stopped` once the process has exited
   * (the `afterStart` failure path uses `error`); external callers omit it.
   *
   * `opts.force` skips the graceful phase: instead of SIGTERM followed by a
   * `stopTimeout` grace period, the process group is SIGKILLed immediately
   * (after the same escaped-descendant sweep the timeout path does). It is also
   * accepted while a service is already `stopping`, where it cuts short the
   * grace period of the stop already in flight. That wedged case is the main
   * reason to reach for it.
   *
   * `opts.graceMs` overrides how long this one stop waits before escalating,
   * instead of the service's configured `stopTimeout`. It exists for automation:
   * a script or agent restarting a service in a loop pays the full grace period
   * every time, and usually knows its own service shuts down far quicker than
   * the configured default allows for. Non-positive values fall back to the
   * configured timeout (the same convention every other numeric option here
   * follows), so `force` remains the way to ask for no grace period at all.
   */
  async stopService(
    serviceID: string,
    opts: {
      finalStatus?: Service["status"];
      errorDetails?: string;
      force?: boolean;
      graceMs?: number;
    } = {},
  ): Promise<void> {
    const service = this.getService(serviceID);
    if (!service) return;

    // Join an in-flight stop rather than starting a second one, optionally
    // retuning it on the way in: `force` escalates it to SIGKILL now, and a
    // `graceMs` override re-arms its grace period (usually to cut the remaining
    // wait short). Either way the original caller's promise is the one
    // returned, so it still settles once. A caller that asked for no tuning
    // just waits it out, which is what "stop this service" means: returning
    // early would report the service as still `stopping` even though the stop
    // is proceeding perfectly normally.
    if (service.status === "stopping") {
      const inFlight = this.inFlightStops.get(serviceID);
      if (inFlight) {
        if (opts.force) inFlight.escalate();
        else if (opts.graceMs !== undefined) inFlight.retime(opts.graceMs);
        // Echo the current status, as the plain duplicate-stop path below did
        // before this joined instead of returning, so a client that asks twice
        // still gets a frame back.
        else this.setStatus(serviceID, "stopping", service.errorDetails);
        return inFlight.promise;
      }
    }

    // If a post-start hook is still running, abort it so it bails out. The
    // process is already live, so fall through to the normal kill path below.
    if (service.status === "finalizing") {
      this.abortControllers.get(serviceID)?.abort();
      this.abortControllers.delete(serviceID);
    }

    // If the service is still running its pre-start hook, abort it and treat
    // this as a clean stop: no process has been spawned yet.
    if (service.status === "initializing") {
      const controller = this.abortControllers.get(serviceID);
      controller?.abort();
      this.abortControllers.delete(serviceID);
      this.logger.info(
        `Service ${service.name} stopped during initialization.`,
      );
      this.addLog(
        serviceID,
        `${service.name} stopped before start (pre-start hook aborted).`,
        "system",
      );
      this.setStatus(serviceID, "stopped");
      return;
    }

    if (
      !service.process ||
      service.status === "stopped" ||
      service.status === "stopping"
    ) {
      if (
        service &&
        (service.status === "stopped" || service.status === "stopping")
      ) {
        this.setStatus(serviceID, service.status, service.errorDetails);
      }
      return;
    }

    this.logger.info(`Stopping service: ${service.name}...`);
    this.setStatus(serviceID, "stopping");
    this.addLog(
      serviceID,
      opts.force
        ? `Force-stopping ${service.name}...`
        : `Attempting to stop ${service.name}...`,
      "system",
    );

    // Assigned by the promise executor (which runs synchronously) so the
    // in-flight entry registered just below can expose them.
    let escalateStop: () => void = () => {};
    let retimeStop: (graceMs: number) => void = () => {};
    let readGraceEndsAt: () => number = () => 0;

    const run = new Promise<void>((resolve) => {
      if (!service.process) {
        const finalStatus = opts.finalStatus ?? "stopped";
        const finalErrorDetails = opts.finalStatus
          ? (opts.errorDetails ?? service.errorDetails)
          : service.errorDetails;
        this.setStatus(serviceID, finalStatus, finalErrorDetails);
        resolve();
        return;
      }

      const leaderPid = service.process.pid;

      service.process.removeAllListeners("exit");
      service.process.on("exit", () => {
        this.logger.info(`Service ${service.name} confirmed stopped.`);
        this.addLog(serviceID, `${service.name} confirmed stopped.`, "system");

        // Settle on the requested final status, or `stopped` for a normal stop
        // (keeping an already-`error` status if something set it mid-stop).
        const finalStatus: Service["status"] = opts.finalStatus
          ? opts.finalStatus
          : service.status === "error"
            ? "error"
            : "stopped";
        const finalErrorDetails = opts.finalStatus
          ? (opts.errorDetails ?? service.errorDetails)
          : service.errorDetails;

        // Tear down fully (drop the handle, reap the old group) before the
        // transition so the broadcast reflects a fully-dead service. Waiter
        // notification is async (see setStatus), so a mid-stop start can't run
        // until this handler returns. The ordering here is just for a clean
        // snapshot, no longer load-bearing against re-entrant restarts.
        service.process = null;
        clearTimeout(timeout);
        // Default (group SIGTERM) services: the leader has exited, but members
        // of its group may still be alive (e.g. a child that ignored SIGTERM),
        // so force-kill the group to reap them. No-op if the group is already
        // empty, and it's in the same tick as the exit so there's no pid-reuse
        // window.
        //
        // gracefulShutdown services are deliberately excluded: SIGTERM went to
        // the main process only so it can coordinate its own children, so we
        // must NOT kill those children out from under it when it exits. The
        // force-kill timeout above remains the safety net for a *hung* main.
        if (
          this.useProcessGroups &&
          !service.gracefulShutdown &&
          leaderPid !== undefined
        ) {
          try {
            process.kill(-leaderPid, "SIGKILL");
          } catch {
            // Group already empty, nothing left to reap.
          }
        }

        this.setStatus(serviceID, finalStatus, finalErrorDetails);
        resolve();
      });

      // Declared before `escalate` so the closure can clear it; assigned below.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let escalated = false;
      // When the currently-armed grace period expires, on `performance.now()`'s
      // monotonic clock. 0 until one is armed, and on the `force` path, which
      // arms none at all.
      let graceEndsAt = 0;

      /**
       * Jump to SIGKILL. Reached either by the grace period expiring or by a
       * force stop (at request time, or arriving mid-stop). Guarded so the two
       * can't both fire.
       */
      const escalate = (reason: "timeout" | "forced") => {
        if (escalated) return;
        escalated = true;
        clearTimeout(timeout);

        if (!service.process) return;

        if (reason === "forced") {
          this.logger.warn(`Force-stopping ${service.name} with SIGKILL.`);
          this.addLog(
            serviceID,
            `Force stop requested: sending SIGKILL to ${service.name}.`,
            "system",
          );
        } else {
          this.logger.warn(
            `Service ${service.name} did not stop gracefully with SIGTERM, sending SIGKILL.`,
          );
          this.addLog(
            serviceID,
            `${service.name} did not stop gracefully, forcing SIGKILL.`,
            "system",
          );
        }

        // Force-kill the whole group, plus any descendants that escaped it.
        // The walk runs while the process is still alive (so pids are
        // current), then we send the group SIGKILL once it's done.
        void this.reapEscapedDescendants(leaderPid).then(() => {
          this.stopSignal(service, "SIGKILL", true);
        });
      };

      /**
       * (Re-)arms the grace period, measured from now. `clampTimerMs` keeps a
       * huge `graceMs` from overflowing setTimeout's 32-bit delay, which Node
       * would silently turn into a 1ms wait, i.e. an immediate SIGKILL.
       */
      const armGrace = (graceMs: number | undefined) => {
        if (timeout) clearTimeout(timeout);
        // `positiveOr` so a per-service `stopTimeout` of 0 (or negative) falls
        // back to the global default rather than meaning "SIGKILL immediately".
        // A per-request `graceMs` takes precedence over both, and is guarded
        // the same way, so a bad override can't collapse the grace period.
        const delay = clampTimerMs(
          positiveOr(
            graceMs,
            positiveOr(service.stopTimeout, this.defaultStopTimeout),
          ),
        );
        // Published so a start that has to wait this stop out can size its own
        // deadline against the grace period actually armed, not the configured
        // one (see `stopGraceEndsAt`). `performance.now()` rather than
        // `Date.now()` so it measures the same monotonic clock `setTimeout`
        // does: a wall-clock jump (NTP, sleep/wake) would otherwise make the
        // remaining grace disagree with when the timer actually fires.
        graceEndsAt = performance.now() + delay;
        timeout = setTimeout(() => escalate("timeout"), delay);
      };

      escalateStop = () => escalate("forced");
      readGraceEndsAt = () => (escalated ? 0 : graceEndsAt);
      retimeStop = (graceMs: number) => {
        // Nothing to re-arm once we've already jumped to SIGKILL.
        if (escalated || !service.process) return;
        this.addLog(
          serviceID,
          `Grace period for ${service.name} reset to ${graceMs}ms.`,
          "system",
        );
        armGrace(graceMs);
        // Re-broadcast `stopping` so a `startAndWait` already parked on this
        // stop re-reads the grace period and extends its own deadline. Without
        // it, lengthening the grace of a stop a start is already waiting on
        // would time that start out early (the deadline it armed was a snapshot
        // taken before this retime). Same no-op frame the duplicate-stop path
        // sends, so clients see nothing new.
        this.setStatus(serviceID, "stopping", service.errorDetails);
      };

      if (opts.force) {
        // Straight to SIGKILL: no SIGTERM, no grace period, no timer to arm.
        escalate("forced");
        return;
      }

      // Graceful stop: SIGTERM to just the main process so it can coordinate
      // its own children. Otherwise signal the whole process group.
      this.stopSignal(service, "SIGTERM", !service.gracefulShutdown);

      armGrace(opts.graceMs);
    });

    this.inFlightStops.set(serviceID, {
      promise: run,
      escalate: escalateStop,
      retime: retimeStop,
      graceEndsAt: readGraceEndsAt,
    });
    void run.finally(() => {
      if (this.inFlightStops.get(serviceID)?.promise === run) {
        this.inFlightStops.delete(serviceID);
      }
    });

    return run;
  }

  /**
   * When the in-flight stop of this service is due to escalate to SIGKILL, on
   * `performance.now()`'s monotonic clock. 0 when no stop is under way, when
   * one has already escalated, or on the `force` path, which arms no grace
   * period at all.
   *
   * A stop's grace period isn't necessarily the service's configured
   * `stopTimeout`: a per-request `graceMs` (or a `retime` of a stop already
   * under way) can set a far longer one. Anything sizing a deadline against
   * "how long could this stop still legitimately take" has to ask here rather
   * than read `stopTimeout`, or it will give up while the stop is proceeding
   * exactly as asked.
   *
   * An absolute point rather than a remaining duration on purpose: a waiter
   * comparing successive readings can then tell an actual extension of the
   * grace period from the mere passage of time.
   */
  private stopGraceEndsAt(serviceID: string): number {
    return this.inFlightStops.get(serviceID)?.graceEndsAt() ?? 0;
  }

  /**
   * Stops the service (if anything is up) and starts it again, returning
   * whether the start half actually reached `running`, so a caller can report
   * a truthful outcome rather than assuming a restart succeeded. False also
   * covers the two early returns: a restart refused during shutdown, and an
   * unknown service ID.
   *
   * `opts.force` / `opts.graceMs` are passed through to the stop half, so a
   * caller that restarts repeatedly (a script or an agent iterating on a
   * service) doesn't have to pay the configured grace period on every cycle.
   */
  async restartService(
    serviceID: string,
    opts: { force?: boolean; graceMs?: number } = {},
  ): Promise<boolean> {
    // Restart would stop then start; during shutdown the start half must not run.
    if (this.shuttingDown) return false;

    const service = this.getService(serviceID);
    if (!service) return false;

    this.logger.info(`Restarting service: ${service.name}...`);
    this.addLog(
      serviceID,
      `Attempting to restart ${service.name}...`,
      "system",
    );

    // Stop first if there's anything to tear down. A live process (running /
    // starting / finalizing) needs killing; `initializing` has no process yet
    // but is still an in-flight start whose `beforeStart` stopService aborts, so
    // a restart there must cancel it and run a fresh one rather than silently
    // rejoin the existing hook run.
    if (
      service.process &&
      service.status !== "stopped" &&
      service.status !== "error"
    ) {
      await this.stopService(serviceID, {
        force: opts.force,
        graceMs: opts.graceMs,
      });
      // Brief settle pause between teardown and respawn: lets the OS finish
      // releasing the old process's resources (e.g. its listening port) so the
      // new process doesn't immediately hit EADDRINUSE on a fast restart. Kept
      // fixed and not overridable, since it guards a real race, and shortening it
      // trades a rare hang for a much more annoying flaky start.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else if (service.status === "initializing") {
      // Pre-spawn: no process to release (so no settle pause), but abort the
      // in-flight pre-start hook so the start below runs a fresh one.
      await this.stopService(serviceID, {
        force: opts.force,
        graceMs: opts.graceMs,
      });
    }

    // The start we just aborted may still be an in-flight `startAndWait` run
    // (the normal WebSocket start path leaves a promise in `inFlightStarts`,
    // e.g. a service hung in a slow `beforeStart`). That entry is cleared
    // asynchronously once the run settles, so wait for it here; otherwise the
    // `startAndWait` below would rejoin the just-aborted run and resolve with
    // its (failed) result instead of beginning a fresh start.
    const pending = this.inFlightStarts.get(serviceID);
    if (pending) await pending;

    // Use the timeout-aware path so a hung beforeStart/afterStart on restart
    // can't leave the service stuck in initializing/finalizing forever.
    return this.startAndWait(serviceID);
  }

  clearServiceLogs(serviceID: string) {
    const service = this.getService(serviceID);
    if (service) {
      // Clearing a non-empty buffer drops lines exactly the way an eviction
      // does, so it counts as one: a poller holding a cursor from before the
      // clear would otherwise be told `truncated: false` and never learn that
      // what sat between its cursor and here is gone. (The system line the
      // clear writes is no substitute, a poller filtering on
      // `logType=stdout,stderr` never sees it.) An already-empty buffer had
      // nothing to lose, so it stays as it was.
      if (service.logs.length === 0) this.evictedLogs.delete(serviceID);
      else this.evictedLogs.add(serviceID);
      service.logs = [];
      this.logger.info(`Server-side logs cleared for service: ${service.name}`);
      this.addLog(serviceID, "Log buffer cleared by user.", "system");
      this.broadcastFn({ type: "logs_cleared", serviceID });
    }
  }

  /**
   * Stops every live service in reverse start order.
   *
   * `opts` is passed through to each individual stop, so a "Force Stop All"
   * escalates the whole run, including services already `stopping` from the
   * graceful run it's escalating, which is the point: a wedged stack otherwise
   * makes you wait out every service's grace period in turn.
   */
  async stopAllServices(
    opts: { force?: boolean; graceMs?: number } = {},
  ): Promise<StopAllSummary> {
    // Stop sequentially in reverse start order so dependents shut down before
    // the dependencies they rely on.
    //
    // A run carrying tuning also picks up services already `stopping`. They're
    // skipped normally (a stop is already under way, so there'd be nothing to
    // do), but those are exactly the ones a "Force Stop All" is aimed at: the
    // run it is escalating left them waiting out their grace periods. A
    // `graceMs` override reaches them the same way, re-arming the in-flight
    // stop rather than leaving the caller's shorter deadline on the floor.
    const retunes = opts.force || opts.graceMs !== undefined;
    const toStop = [...this.services]
      .reverse()
      .filter(
        (s) =>
          s.status === "initializing" ||
          (s.process &&
            (s.status === "running" ||
              s.status === "starting" ||
              s.status === "finalizing" ||
              (retunes && s.status === "stopping"))),
      );

    const total = toStop.length;
    let stopped = 0;
    let failed = 0;

    // Nothing running (e.g. server shutdown with no active services). Stay
    // silent rather than broadcasting a begin/done pair that renders a
    // confusing "0 services stopped" toast right before the socket closes.
    if (total === 0) {
      this.logger.info("All services stopped.");
      return { stopped: 0, failed: 0, total: 0 };
    }

    this.broadcastFn({ type: "stop_all_begin", total });

    try {
      for (const service of toStop) {
        let ok = true;
        try {
          await this.stopService(service.id, {
            force: opts.force,
            graceMs: opts.graceMs,
          });
        } catch (err) {
          ok = false;
          this.logger.error(
            `Error stopping ${service.name} during shutdown:`,
            err as object,
          );
        }
        if (ok) stopped++;
        else failed++;
        this.broadcastFn({
          type: "stop_all_progress",
          serviceID: service.id,
          serviceName: service.name,
          // Report the truth: a stop that threw isn't a clean "stopped".
          result: ok ? "stopped" : "failed",
          stopped,
          failed,
          total,
        });
      }
    } finally {
      this.broadcastFn({ type: "stop_all_done", stopped, failed });
      this.logger.info("All services stopped.");
    }

    return { stopped, failed, total };
  }

  /**
   * All services that depend (directly or transitively) on the given service.
   */
  private getTransitiveDependents(serviceID: string): Set<string> {
    const result = new Set<string>();
    const queue = [serviceID];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const svc of this.services) {
        if (svc.dependsOn?.includes(current) && !result.has(svc.id)) {
          result.add(svc.id);
          queue.push(svc.id);
        }
      }
    }
    return result;
  }

  /**
   * Turns a "Start All" wait window elapsing (`startTimeout` /
   * `beforeStartTimeout` / `afterStartTimeout`) into a hard deadline: aborts a
   * running hook, tears down any live process, and puts the service into
   * `error`, so a hung hook ends the attempt instead of leaving the service
   * spinning forever. Awaited by `startAndWait` before it resolves false, so the
   * process is actually down (ports freed) before Start All moves on and its
   * dependents are skipped.
   */
  private async failStartOnTimeout(serviceID: string): Promise<void> {
    const service = this.getService(serviceID);
    if (!service) return;

    const reason =
      service.status === "initializing"
        ? "beforeStart hook timed out"
        : service.status === "finalizing"
          ? "afterStart hook timed out"
          : "timed out waiting to start";

    this.logger.warn(`Service ${service.name}: ${reason}.`);
    this.addLog(serviceID, `${service.name} ${reason}.`, "system");

    if (service.status === "stopping") {
      // A stop is already tearing this down and owns the process, so there is
      // nothing for us to stop. Explicitly do NOT join that stop: this deadline
      // is armed precisely for a stop that isn't completing (see the
      // `stopping` branch of runStartAndWait), so awaiting it would park the
      // start forever instead of failing it. The in-flight stop settles the
      // service on its own.
      return;
    }

    if (service.process) {
      // A process is live (starting/finalizing). stopService aborts the hook
      // (its finalizing branch) and tears the process down, settling on error.
      // Awaited so the teardown completes before the failed start is reported.
      await this.stopService(serviceID, {
        finalStatus: "error",
        errorDetails: reason,
      });
    } else {
      // No process yet (initializing / pre-spawn): abort the hook and mark
      // error directly. The hook's abort guard makes it bail without spawning.
      this.abortControllers.get(serviceID)?.abort();
      this.abortControllers.delete(serviceID);
      service.process = null;
      this.setStatus(serviceID, "error", reason);
    }
  }

  /**
   * Starts a service and resolves once it reaches a terminal start state:
   * `true` on `running`, `false` on error/crash/stop or timeout. The wait is
   * driven by status transitions (setStatus → startWaiters), and uses
   * three windows: `beforeStartTimeout` while `initializing`, `startTimeout`
   * while `starting`, `afterStartTimeout` while `finalizing`. A window elapsing
   * is a hard deadline (see `failStartOnTimeout`).
   *
   * This is the timeout-aware start entry used for every user-facing start
   * ("Start All", a manual single-service start, and restart), so a hung hook
   * can never leave a service parked in `initializing`/`finalizing` forever.
   * (The raw `startService` primitive it drives has no timeout of its own.)
   *
   * Concurrent calls for the same service are deduped onto a single run: a
   * second start while one is already in flight (e.g. repeated manual starts,
   * or a manual start racing "Start All") returns the existing promise instead
   * of arming a second timer. See `inFlightStarts`.
   */
  startAndWait(serviceID: string): Promise<boolean> {
    // Refuse to begin a (timeout-aware) start once the server is shutting down;
    // report it as a failed start so any caller (e.g. Start All) moves on.
    if (this.shuttingDown) return Promise.resolve(false);

    const existing = this.inFlightStarts.get(serviceID);
    if (existing) return existing;

    const run = this.runStartAndWait(serviceID);
    this.inFlightStarts.set(serviceID, run);
    // Drop the in-flight entry once it settles, but only if it's still ours (a
    // later run may have replaced it after this one resolved).
    void run.finally(() => {
      if (this.inFlightStarts.get(serviceID) === run) {
        this.inFlightStarts.delete(serviceID);
      }
    });

    return run;
  }

  private runStartAndWait(serviceID: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.startWaiters.delete(serviceID);
        resolve(ok);
      };

      const arm = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onTimeout, ms);
      };

      // While parked on an in-flight stop (`awaitingStop`), the point that
      // stop's grace period was last seen to end. Compared against a fresh
      // reading to tell a genuine extension of the grace period from the mere
      // passage of time. See the `awaitingStop` branch of the waiter.
      let stopGraceEnd = 0;

      // Arm the window appropriate to a given phase. A service started manually
      // just before Start All may already be mid-lifecycle, so we don't assume
      // it's at the `starting` phase.
      const armForStatus = (status: Service["status"]) => {
        if (status === "initializing") arm(this.beforeStartTimeout);
        else if (status === "finalizing") arm(this.afterStartTimeout);
        else arm(this.startTimeout);
      };

      // A wait window elapsing is a hard deadline: abort the hook / tear down
      // any live process and put the service into `error` (rather than leave it
      // spinning in initializing/finalizing), and only resolve the wait as
      // failed once that teardown is done so ports are freed before Start All
      // moves on. We clear the bookkeeping up front so the teardown's own status
      // broadcasts don't re-enter the waiter.
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.startWaiters.delete(serviceID);
        void this.failStartOnTimeout(serviceID).then(() => resolve(false));
      };

      // When a start is requested while the service is still `stopping`, we
      // don't fail it: we wait for the in-flight stop to finish (`stopped`) and
      // then start a fresh run, so "start" means "start" even mid-stop. The flag
      // flips off once that start is kicked, after which a later `stopped` is a
      // genuine failed start again.
      let awaitingStop = false;

      this.startWaiters.set(serviceID, (status) => {
        // Notifications arrive asynchronously (see setStatus), so a status
        // queued before this run settled can still be delivered afterwards;
        // ignore it once settled so a stale event can't arm a stray timer.
        if (settled) return;
        if (status === "running") finish(true);
        else if (status === "stopped") {
          if (awaitingStop) {
            // The pending stop completed, so now actually start it.
            awaitingStop = false;
            arm(this.startTimeout);
            void this.startService(serviceID);
          } else {
            finish(false);
          }
        } else if (status === "error" || status === "crashed") finish(false);
        else if (awaitingStop) {
          // Still waiting for the in-flight stop to finish. Never fall through
          // to `armForStatus`, which would swap in the much shorter
          // `startTimeout` and time the start out before the stop could
          // possibly complete.
          //
          // A `retime` that lengthened this stop's grace period re-broadcasts
          // `stopping` precisely so we pick it up here and push our own
          // deadline out to match. Gate that on the grace period having
          // actually moved later, not on a recomputed duration: a plain
          // duplicate stopService() call also re-broadcasts `stopping` without
          // changing anything, and re-arming on those would let a client that
          // spams stop keep the start parked indefinitely.
          const graceEnd = this.stopGraceEndsAt(serviceID);
          if (graceEnd > stopGraceEnd) {
            stopGraceEnd = graceEnd;
            arm(clampTimerMs(graceEnd - performance.now() + this.startTimeout));
          }
          return;
        } else armForStatus(status);
      });

      const service = this.getService(serviceID);
      // Already up, so nothing to wait for.
      if (service?.status === "running") {
        finish(true);
        return;
      }

      // Start requested while the service is still tearing down: wait for the
      // stop to finish, then start a fresh run (the waiter above kicks the start
      // on `stopped`). The stop's own SIGKILL fires when its grace period
      // expires, so we wait that long plus a further `startTimeout` of grace for
      // the kill to be reaped before giving up: a genuinely hung stop fails the
      // start rather than parking here forever, while a merely-slow teardown
      // still gets a generous window to complete.
      //
      // The grace period is read from the stop actually in flight, not from the
      // configured `stopTimeout`: a per-request `graceMs` can have armed a much
      // longer one, and sizing against the configured value would fail the
      // start while that stop is proceeding perfectly normally. A `retime`
      // arriving after this deadline is armed is picked up too, via the
      // `stopping` re-broadcast the waiter above extends on.
      if (service?.status === "stopping") {
        awaitingStop = true;
        stopGraceEnd = this.stopGraceEndsAt(serviceID);
        arm(
          // The configured `stopTimeout` stays a floor, so the ordinary case
          // (no per-request override) arms exactly the deadline it always did,
          // and a stop with no grace armed at all (a `force` stop) still gets a
          // sane window rather than just `startTimeout`. `clampTimerMs` because
          // a near-maximum grace plus `startTimeout` would otherwise overflow
          // what setTimeout can hold and collapse to 1ms.
          clampTimerMs(
            Math.max(
              stopGraceEnd - performance.now(),
              positiveOr(service.stopTimeout, this.defaultStopTimeout),
            ) + this.startTimeout,
          ),
        );
        return;
      }

      armForStatus(service?.status ?? "starting");
      // Only (re)start a service that's actually in a startable state. If it's
      // already in-flight (initializing/starting/finalizing, e.g. started
      // manually moments earlier), startService would refuse and broadcast
      // nothing, so we just attach to its existing run via the waiter above.
      if (
        service &&
        (service.status === "stopped" ||
          service.status === "error" ||
          service.status === "crashed")
      ) {
        void this.startService(serviceID);
      }
    });
  }

  /**
   * Starts all services in dependency order, waiting for each to come up before
   * starting the next. If one fails (or times out), its transitive dependents
   * are skipped while unrelated services keep starting. Progress is broadcast
   * via `start_all_begin` / `start_all_progress` / `start_all_done` so clients
   * can render it without orchestrating anything themselves.
   */
  async startAllServices(): Promise<StartAllSummary> {
    if (this.shuttingDown || this.startAllInProgress) {
      return {
        ran: false,
        started: 0,
        failed: 0,
        skipped: 0,
        total: this.services.length,
      };
    }
    this.startAllInProgress = true;

    const total = this.services.length;
    const skipped = new Set<string>();
    const skippedBy = new Map<string, string>(); // serviceID -> failed dep name
    let started = 0;
    let failed = 0;

    const progress = (
      service: Service,
      result: "starting" | "started" | "failed" | "skipped",
      extra: { dependencyName?: string; errorDetails?: string | null } = {},
    ) => {
      this.broadcastFn({
        type: "start_all_progress",
        serviceID: service.id,
        serviceName: service.name,
        result,
        started,
        total,
        ...extra,
      });
    };

    this.broadcastFn({ type: "start_all_begin", total });

    try {
      for (const service of this.services) {
        if (skipped.has(service.id)) {
          const dep = skippedBy.get(service.id) ?? "a dependency";
          progress(service, "skipped", { dependencyName: dep });
          this.addLog(
            service.id,
            `Skipping ${service.name}: dependency '${dep}' failed.`,
            "system",
          );
          continue;
        }

        // Already fully running, so count it and move on. Services that are only
        // on their way up (initializing/starting/finalizing, e.g. started
        // manually moments ago) fall through to startAndWait so we actually wait
        // for them to reach `running` before starting their dependents.
        if (service.status === "running") {
          started++;
          progress(service, "started");
          continue;
        }

        progress(service, "starting");

        const ok = await this.startAndWait(service.id);
        if (ok) {
          started++;
          progress(service, "started");
        } else {
          failed++;
          for (const depId of this.getTransitiveDependents(service.id)) {
            if (!skipped.has(depId)) {
              skipped.add(depId);
              skippedBy.set(depId, service.name);
            }
          }
          progress(service, "failed", { errorDetails: service.errorDetails });
        }
      }
    } finally {
      this.startAllInProgress = false;
      this.broadcastFn({
        type: "start_all_done",
        started,
        failed,
        skipped: skipped.size,
      });
    }

    return { ran: true, started, failed, skipped: skipped.size, total };
  }
}
