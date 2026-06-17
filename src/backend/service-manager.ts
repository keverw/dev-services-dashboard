import { spawn } from "child_process";
import { constants } from "os";
import { Service, UserServiceConfig, LogEntry } from "./types";
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

export class ServiceManager {
  private services: Service[] = [];
  private maxLogLines: number;
  private broadcastFn: (message: object) => void;
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

  constructor(
    logger: Logger,
    userServices: UserServiceConfig[],
    maxLogLines: number,
    broadcastFn: (message: object) => void,
    defaultCwd: string | undefined,
    defaultStopTimeout: number = 5000,
  ) {
    this.maxLogLines = maxLogLines;
    this.broadcastFn = broadcastFn;
    this.logger = logger;
    this.defaultStopTimeout = defaultStopTimeout;

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
          webLinks: service.webLinks ?? [],
          log: (line: string) => this.addLog(serviceID, line, "system"),
          signal: controller.signal,
        });

        // If the user stopped the service while the hook ran, stopService has
        // already transitioned it to "stopped"; just bail out.
        if (controller.signal.aborted) {
          clearOwnController();
          return;
        }

        // Apply any env / web link overrides the hook returned.
        if (result?.env) mergedEnv = result.env;
        if (result?.webLinks) {
          service.webLinks = result.webLinks;
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
        service.status = "running";
        this.logger.info(
          `Service ${service.name} started (PID: ${service.process?.pid}).`,
        );
        this.addLog(
          serviceID,
          `${service.name} started successfully.`,
          "system",
        );
        this.broadcastStatus(serviceID, service.status);
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
   * Sends an arbitrary POSIX signal to a running service process. The signal
   * must be a known signal name (validated against `os.constants.signals`).
   * No-op if the service is not currently running.
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

  async stopService(serviceID: string): Promise<void> {
    const service = this.getService(serviceID);
    if (!service) return;

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
        service.status = "stopped";
        this.broadcastStatus(serviceID, service.status);
        resolve();
        return;
      }

      service.process.removeAllListeners("exit");
      service.process.on("exit", () => {
        this.logger.info(`Service ${service.name} confirmed stopped.`);
        this.addLog(serviceID, `${service.name} confirmed stopped.`, "system");
        if (service.status !== "error") service.status = "stopped";
        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        service.process = null;
        clearTimeout(timeout);
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
          const pid = service.process.pid;
          void this.reapEscapedDescendants(pid).then(() => {
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
          (s.process && (s.status === "running" || s.status === "starting")),
      );

    for (const service of toStop) {
      try {
        await this.stopService(service.id);
      } catch (err) {
        this.logger.error(
          `Error stopping ${service.name} during shutdown:`,
          err as object,
        );
      }
    }

    this.logger.info("All services stopped.");
  }
}
