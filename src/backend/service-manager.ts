import { spawn } from "child_process";
import { constants } from "os";
import { Service, UserServiceConfig } from "./types";
import type { LogEntry, ServerMessage } from "@shared/protocol";
import { Logger } from "./logger";

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
  // AbortControllers for services currently running their beforeStart hook.
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
  // (via broadcastStatus) when the service it's waiting on changes status.
  private startWaiters = new Map<string, (status: Service["status"]) => void>();
  private startAllInProgress = false;

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
    this.defaultStopTimeout = options.stopTimeout ?? 5000;
    this.startTimeout = options.startTimeout ?? 10000;
    this.beforeStartTimeout = options.beforeStartTimeout ?? 60000;
    this.afterStartTimeout = options.afterStartTimeout ?? 60000;

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
   * cycles are unresolvable misconfigurations and throw — the dashboard refuses
   * to start rather than run in a misleading order.
   */
  private computeStartOrder(): void {
    const idSet = new Set(this.services.map((s) => s.id));

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

    const line = originalLine.replace(/\[[0-9;]*m/g, ""); // Strip ANSI escape codes

    const logEntry: LogEntry = { timestamp: Date.now(), line, logType };
    service.logs.push(logEntry);
    if (service.logs.length > this.maxLogLines) {
      service.logs.shift();
    }
    this.broadcastLog(serviceID, line, logType, logEntry.timestamp);
  }

  private broadcastLog(
    serviceID: string,
    line: string,
    logType: LogEntry["logType"],
    timestamp: number,
  ) {
    this.broadcastFn({ type: "log", serviceID, line, logType, timestamp });
  }

  private broadcastStatus(
    serviceID: string,
    status: Service["status"],
    errorDetails: string | null = null,
  ) {
    const service = this.getService(serviceID);
    if (service) service.errorDetails = errorDetails;
    this.broadcastFn({
      type: "status_update",
      serviceID,
      status,
      errorDetails,
    });

    // Once a service is no longer up, drop any links its hooks computed for the
    // run (a tunnel URL, a dynamically-chosen port) and revert the card to the
    // configured baseline — a dead service shouldn't show a stale dynamic link.
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

    // Notify a "Start All" waiter watching this service for status changes.
    this.startWaiters.get(serviceID)?.(status);
  }

  async startService(serviceID: string) {
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
      service.status = "initializing";
      this.broadcastStatus(serviceID, service.status);
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
          // Always the configured baseline (a copy), so the hook can't see —
          // and accumulate on top of — links it added on a previous run.
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
        service.status = "error";
        this.logger.error(
          `Pre-start hook failed for ${service.name}:`,
          err as object,
        );
        this.addLog(serviceID, `Pre-start hook failed: ${message}`, "system");
        this.broadcastStatus(serviceID, service.status, message);
        return;
      }

      clearOwnController();
    }

    service.status = "starting";
    this.broadcastStatus(serviceID, service.status);
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

        // If there's a post-start hook, run it as a readiness gate before
        // reporting `running`; otherwise the process being up is enough.
        if (service.afterStart) {
          void this.runAfterStart(serviceID, mergedEnv);
        } else {
          service.status = "running";
          this.addLog(
            serviceID,
            `${service.name} started successfully.`,
            "system",
          );
          this.broadcastStatus(serviceID, service.status);
        }
      });

      service.process.stdout?.on("data", (data: Buffer) =>
        this.addLog(serviceID, data.toString(), "stdout"),
      );
      service.process.stderr?.on("data", (data: Buffer) =>
        this.addLog(serviceID, data.toString(), "stderr"),
      );

      service.process.on("error", (err) => {
        service.status = "error";
        this.logger.error(`Failed to start service ${service.name}:`, err);
        this.addLog(
          serviceID,
          `Error starting ${service.name}: ${err.message}`,
          "system",
        );
        this.broadcastStatus(serviceID, service.status, err.message);
        service.process = null;
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

        service.status = newStatus;
        service.errorDetails = errorDetails;

        const exitMessage = `Service ${service.name} ${exitType} (code ${code}, signal ${signal}).`;
        const logLevel = newStatus === "stopped" ? "info" : "error";

        if (logLevel === "info") {
          this.logger.info(exitMessage);
        } else {
          this.logger.error(exitMessage);
        }
        this.addLog(serviceID, exitMessage, "system");
        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        service.process = null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      service.status = "error";
      this.logger.error(
        `Exception starting service ${service.name}:`,
        err as object,
      );
      this.addLog(
        serviceID,
        `Exception starting ${service.name}: ${message}`,
        "system",
      );
      this.broadcastStatus(serviceID, service.status, message);
      service.process = null;
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

    service.status = "finalizing";
    this.addLog(
      serviceID,
      `Running post-start hook for ${service.name}...`,
      "system",
    );
    this.broadcastStatus(serviceID, service.status);

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
      // exited under it) — something else already set the terminal status, so
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
      // the links — don't apply the hook's results or promote to running, or a
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

      service.status = "running";
      this.addLog(serviceID, `${service.name} started successfully.`, "system");
      this.broadcastStatus(serviceID, service.status);
    } catch (err) {
      // If a newer start has replaced our controller, this run is stale (the
      // service was stopped/restarted while a signal-ignoring hook kept
      // running) — it must not touch the service the current run now owns.
      // Capture before clearOwnController, which would drop our own entry.
      const superseded = this.abortControllers.get(serviceID) !== controller;
      clearOwnController();

      // A stop-driven abort is an intentional stop, not a failure, so bail —
      // stopService already set the status. An exit-driven abort (the process
      // died under the hook) is NOT a clean stop: fall through so a thrown hook
      // still settles the service on `error` — but only while we're still the
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
        // The process is live and holding ports — tear it (and its group) down,
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
        service.status = "error";
        this.broadcastStatus(serviceID, service.status, message);
      }
    }
  }

  /**
   * Sends an arbitrary POSIX signal to a running service process. The signal
   * must be a known signal name (validated against `os.constants.signals`).
   * No-op if the service is not currently running.
   *
   * Unlike stop (which signals the whole process group), this targets ONLY the
   * launched command's main process — by design. Custom signals like `SIGHUP`
   * (reload config) are meant for the process you configured, not blasted at
   * every child it forked. Note the consequence: if your `command` is a wrapper
   * that does not forward signals (e.g. `bun run …`, `vite`, `nodemon`), the
   * signal reaches the wrapper, not the underlying dev server it spawned. If you
   * need the inner process to receive it, run that process directly (or have the
   * wrapper forward signals).
   */
  sendSignal(serviceID: string, signal: string): void {
    const service = this.getService(serviceID);
    if (!service) return;

    if (service.status !== "running" || !service.process) {
      this.logger.warn(
        `Cannot send ${signal} to ${service.name}: service is ${service.status}.`,
      );
      return;
    }

    if (!(signal in constants.signals)) {
      this.logger.warn(
        `Refusing to send unknown signal "${signal}" to ${service.name}.`,
      );
      this.addLog(
        serviceID,
        `Refused to send unknown signal "${signal}".`,
        "system",
      );
      return;
    }

    try {
      service.process.kill(signal as NodeJS.Signals);
      this.logger.info(`Sent ${signal} to ${service.name}.`);
      this.addLog(serviceID, `Sent ${signal} to ${service.name}.`, "system");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send ${signal} to ${service.name}:`,
        err as object,
      );
      this.addLog(serviceID, `Failed to send ${signal}: ${message}`, "system");
    }
  }

  /**
   * Sends a termination signal to a service's process. On POSIX the process was
   * spawned detached (its own process group), so `targetGroup` signals the
   * whole group via a negative PID — reaching children the process forked (e.g.
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
        // Group already gone or signal not permitted — fall back below.
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
   * This is a single pass — no retry. SIGKILL is uncatchable, so anything the
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
        finish(); // ps unavailable — group kill was our best effort
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
   */
  async stopService(
    serviceID: string,
    opts: { finalStatus?: Service["status"]; errorDetails?: string } = {},
  ): Promise<void> {
    const service = this.getService(serviceID);
    if (!service) return;

    // If a post-start hook is still running, abort it so it bails out. The
    // process is already live, so fall through to the normal kill path below.
    if (service.status === "finalizing") {
      this.abortControllers.get(serviceID)?.abort();
      this.abortControllers.delete(serviceID);
    }

    // If the service is still running its pre-start hook, abort it and treat
    // this as a clean stop — no process has been spawned yet.
    if (service.status === "initializing") {
      const controller = this.abortControllers.get(serviceID);
      controller?.abort();
      this.abortControllers.delete(serviceID);
      service.status = "stopped";
      this.logger.info(
        `Service ${service.name} stopped during initialization.`,
      );
      this.addLog(
        serviceID,
        `${service.name} stopped before start (pre-start hook aborted).`,
        "system",
      );
      this.broadcastStatus(serviceID, service.status);
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
        this.broadcastStatus(serviceID, service.status, service.errorDetails);
      }
      return;
    }

    this.logger.info(`Stopping service: ${service.name}...`);
    service.status = "stopping";
    this.broadcastStatus(serviceID, service.status);
    this.addLog(serviceID, `Attempting to stop ${service.name}...`, "system");

    return new Promise((resolve) => {
      if (!service.process) {
        service.status = opts.finalStatus ?? "stopped";

        if (opts.finalStatus)
          service.errorDetails = opts.errorDetails ?? service.errorDetails;

        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        resolve();
        return;
      }

      const leaderPid = service.process.pid;

      service.process.removeAllListeners("exit");
      service.process.on("exit", () => {
        this.logger.info(`Service ${service.name} confirmed stopped.`);
        this.addLog(serviceID, `${service.name} confirmed stopped.`, "system");

        if (opts.finalStatus) {
          service.status = opts.finalStatus;
          service.errorDetails = opts.errorDetails ?? service.errorDetails;
        } else if (service.status !== "error") {
          service.status = "stopped";
        }

        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        service.process = null;
        clearTimeout(timeout);
        // Default (group SIGTERM) services: the leader has exited, but members
        // of its group may still be alive (e.g. a child that ignored SIGTERM),
        // so force-kill the group to reap them before resolving — otherwise
        // stop returns with children still holding ports. No-op if the group
        // is already empty, and it's in the same tick as the exit so there's
        // no pid-reuse window.
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
            // Group already empty — nothing left to reap.
          }
        }
        resolve();
      });

      // Graceful stop: SIGTERM to just the main process so it can coordinate
      // its own children. Otherwise signal the whole process group.
      this.stopSignal(service, "SIGTERM", !service.gracefulShutdown);

      const timeout = setTimeout(() => {
        if (service.process) {
          this.logger.warn(
            `Service ${service.name} did not stop gracefully with SIGTERM, sending SIGKILL.`,
          );

          this.addLog(
            serviceID,
            `${service.name} did not stop gracefully, forcing SIGKILL.`,
            "system",
          );

          // Force-kill the whole group, plus any descendants that escaped it.
          // The walk runs while the process is still alive (so pids are
          // current), then we send the group SIGKILL once it's done.
          void this.reapEscapedDescendants(leaderPid).then(() => {
            this.stopSignal(service, "SIGKILL", true);
          });
        }
      }, service.stopTimeout ?? this.defaultStopTimeout);
    });
  }

  async restartService(serviceID: string) {
    const service = this.getService(serviceID);
    if (!service) return;

    this.logger.info(`Restarting service: ${service.name}...`);
    this.addLog(
      serviceID,
      `Attempting to restart ${service.name}...`,
      "system",
    );

    if (
      service.process &&
      service.status !== "stopped" &&
      service.status !== "error"
    ) {
      await this.stopService(serviceID);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await this.startService(serviceID);
  }

  clearServiceLogs(serviceID: string) {
    const service = this.getService(serviceID);
    if (service) {
      service.logs = [];
      this.logger.info(`Server-side logs cleared for service: ${service.name}`);
      this.addLog(serviceID, "Log buffer cleared by user.", "system");
      this.broadcastFn({ type: "logs_cleared", serviceID });
    }
  }

  async stopAllServices(): Promise<void> {
    // Stop sequentially in reverse start order so dependents shut down before
    // the dependencies they rely on.
    const toStop = [...this.services]
      .reverse()
      .filter(
        (s) =>
          s.status === "initializing" ||
          (s.process &&
            (s.status === "running" ||
              s.status === "starting" ||
              s.status === "finalizing")),
      );

    const total = toStop.length;
    let stopped = 0;
    let failed = 0;

    // Nothing running (e.g. server shutdown with no active services). Stay
    // silent rather than broadcasting a begin/done pair that renders a
    // confusing "0 services stopped" toast right before the socket closes.
    if (total === 0) {
      this.logger.info("All services stopped.");
      return;
    }

    this.broadcastFn({ type: "stop_all_begin", total });

    try {
      for (const service of toStop) {
        let ok = true;
        try {
          await this.stopService(service.id);
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
   * `error` — so a hung hook ends the attempt instead of leaving the service
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
      service.status = "error";
      service.process = null;
      this.broadcastStatus(serviceID, service.status, reason);
    }
  }

  /**
   * Starts a service and resolves once it reaches a terminal start state:
   * `true` on `running`, `false` on error/crash/stop or timeout. The wait is
   * driven by status broadcasts (broadcastStatus → startWaiters), and uses
   * three windows: `beforeStartTimeout` while `initializing`, `startTimeout`
   * while `starting`, `afterStartTimeout` while `finalizing`. A window elapsing
   * is a hard deadline — see `failStartOnTimeout`.
   */
  private startAndWait(serviceID: string): Promise<boolean> {
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

      this.startWaiters.set(serviceID, (status) => {
        if (status === "running") finish(true);
        else if (
          status === "error" ||
          status === "crashed" ||
          status === "stopped"
        )
          finish(false);
        else armForStatus(status);
      });

      const service = this.getService(serviceID);
      // Already up — nothing to wait for.
      if (service?.status === "running") {
        finish(true);
        return;
      }

      armForStatus(service?.status ?? "starting");
      // Only (re)start a service that's actually in a startable state. If it's
      // already in-flight (initializing/starting/finalizing — e.g. started
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
  async startAllServices(): Promise<void> {
    if (this.startAllInProgress) return;
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
            `Skipping ${service.name} — dependency '${dep}' failed.`,
            "system",
          );
          continue;
        }

        // Already fully running — count it and move on. Services that are only
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
  }
}
