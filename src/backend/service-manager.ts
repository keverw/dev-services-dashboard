import { spawn } from "child_process";
import { Service, UserServiceConfig, LogEntry } from "./types";
import { logMessage } from "./utils";

export class ServiceManager {
  private services: Service[] = [];
  private maxLogLines: number;
  private broadcastFn: (message: object) => void;

  constructor(
    userServices: UserServiceConfig[],
    maxLogLines: number,
    broadcastFn: (message: object) => void,
    defaultCwd?: string,
  ) {
    this.maxLogLines = maxLogLines;
    this.broadcastFn = broadcastFn;

    // Convert user service configs to full service objects
    this.services = userServices.map((userService) => ({
      id: userService.id,
      name: userService.name,
      command: userService.command,
      cwd: userService.cwd || defaultCwd || process.cwd(),
      env: userService.env,
      webLinks: userService.webLinks,
      process: null,
      status: "stopped",
      logs: [],
      errorDetails: null,
    }));
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
      (service.status !== "stopped" && service.status !== "error")
    ) {
      logMessage(
        "warn",
        `Service ${service?.name} is ${service?.status}, cannot start.`,
      );
      return;
    }

    logMessage("info", `Starting service: ${service.name}...`);
    service.status = "starting";
    service.errorDetails = null;
    this.broadcastStatus(serviceID, service.status);
    this.addLog(serviceID, `Attempting to start ${service.name}...`, "system");

    try {
      service.process = spawn(service.command[0], service.command.slice(1), {
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      service.process.on("spawn", () => {
        service.status = "running";
        logMessage(
          "info",
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
        logMessage("error", `Failed to start service ${service.name}:`, err);
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

        logMessage(logLevel, exitMessage);
        this.addLog(serviceID, exitMessage, "system");
        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        service.process = null;
      });
    } catch (err: any) {
      service.status = "error";
      logMessage("error", `Exception starting service ${service.name}:`, err);
      this.addLog(
        serviceID,
        `Exception starting ${service.name}: ${err.message}`,
        "system",
      );
      this.broadcastStatus(serviceID, service.status, err.message);
      service.process = null;
    }
  }

  async stopService(serviceID: string): Promise<void> {
    const service = this.getService(serviceID);
    if (
      !service ||
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

    logMessage("info", `Stopping service: ${service.name}...`);
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
      service.process.on("exit", (code, signal) => {
        logMessage("info", `Service ${service.name} confirmed stopped.`);
        this.addLog(serviceID, `${service.name} confirmed stopped.`, "system");
        if (service.status !== "error") service.status = "stopped";
        this.broadcastStatus(serviceID, service.status, service.errorDetails);
        service.process = null;
        clearTimeout(timeout);
        resolve();
      });

      service.process.kill("SIGTERM");
      const timeout = setTimeout(() => {
        if (service.process) {
          logMessage(
            "warn",
            `Service ${service.name} did not stop gracefully with SIGTERM, sending SIGKILL.`,
          );
          this.addLog(
            serviceID,
            `${service.name} did not stop gracefully, forcing SIGKILL.`,
            "system",
          );
          service.process.kill("SIGKILL");
        }
      }, 5000);
    });
  }

  async restartService(serviceID: string) {
    const service = this.getService(serviceID);
    if (!service) return;

    logMessage("info", `Restarting service: ${service.name}...`);
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
      logMessage(
        "info",
        `Server-side logs cleared for service: ${service.name}`,
      );
      this.addLog(serviceID, "Log buffer cleared by user.", "system");
      this.broadcastFn({ type: "logs_cleared", serviceID });
    }
  }

  async stopAllServices(): Promise<void> {
    const stopPromises = this.services
      .filter(
        (s) => s.process && (s.status === "running" || s.status === "starting"),
      )
      .map((s) => this.stopService(s.id));

    await Promise.all(stopPromises)
      .then(() => logMessage("info", "All services stopped."))
      .catch((err) =>
        logMessage("error", "Error stopping services during shutdown:", err),
      );
  }
}
