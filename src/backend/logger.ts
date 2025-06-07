import { DevServicesDashboardLoggerFunction } from "./types";

/**
 * Console-based logger implementation for DevUI
 * @param enabled Whether logging is enabled (default: true)
 */
export const createConsoleLogger = (
  enabled: boolean = true,
): DevServicesDashboardLoggerFunction => {
  return (type, message, data) => {
    if (!enabled) return;

    const timestamp = new Date().toISOString();
    console[type](
      `[${timestamp}] [DevUI ${type.toUpperCase()}] ${message}`,
      data || "",
    );
  };
};

/**
 * Logger class that wraps a DevServicesDashboardLoggerFunction for dependency injection
 */
export class Logger {
  private loggerFn?: DevServicesDashboardLoggerFunction;

  constructor(logger?: DevServicesDashboardLoggerFunction) {
    this.loggerFn = logger;
  }

  info(message: string, data?: object): void {
    if (this.loggerFn) {
      this.loggerFn("info", message, data);
    }
  }

  error(message: string, data?: object): void {
    if (this.loggerFn) {
      this.loggerFn("error", message, data);
    }
  }

  warn(message: string, data?: object): void {
    if (this.loggerFn) {
      this.loggerFn("warn", message, data);
    }
  }
}
