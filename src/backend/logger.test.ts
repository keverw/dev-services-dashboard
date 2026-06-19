import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { createConsoleLogger, Logger } from "./logger";

describe("createConsoleLogger", () => {
  afterEach(() => {
    // Restore any console spies created in a test.
    (console.info as unknown as { mockRestore?: () => void }).mockRestore?.();
    (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
    (console.warn as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  it("logs through the matching console method when enabled", () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const log = createConsoleLogger(true);
    log("info", "hello", { a: 1 });
    log("error", "broke");
    log("warn", "careful");

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // Message is formatted with a timestamp + level prefix.
    expect(info.mock.calls[0][0]).toContain("[DevUI INFO] hello");
  });

  it("is silent when disabled", () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const log = createConsoleLogger(false);
    log("info", "should not appear");
    expect(info).not.toHaveBeenCalled();
  });

  it("defaults to enabled", () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const log = createConsoleLogger();
    log("info", "on by default");
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("Logger", () => {
  it("forwards calls to the wrapped logger function", () => {
    const calls: Array<[string, string, object | undefined]> = [];
    const logger = new Logger((type, message, data) =>
      calls.push([type, message, data]),
    );

    logger.info("i", { a: 1 });
    logger.error("e");
    logger.warn("w");

    expect(calls).toEqual([
      ["info", "i", { a: 1 }],
      ["error", "e", undefined],
      ["warn", "w", undefined],
    ]);
  });

  it("is a no-op when constructed without a logger function", () => {
    const logger = new Logger();
    // Should not throw.
    expect(() => {
      logger.info("i");
      logger.error("e");
      logger.warn("w");
    }).not.toThrow();
  });
});
