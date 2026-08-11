import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createServer } from "net";

// Same fake child process the control-API tests use: reports a successful spawn,
// and reports an exit when killed so stops resolve promptly.
mock.module("child_process", () => ({
  spawn: mock(() => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const mockProcess = {
      on: mock((event: string, callback: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(callback);
        if (event === "spawn") setTimeout(() => callback(), 5);
        return mockProcess;
      }),
      stdout: { on: mock() },
      stderr: { on: mock() },
      kill: mock(() => {
        setTimeout(() => {
          for (const cb of listeners.exit ?? []) cb(0, null);
          for (const cb of listeners.close ?? []) cb(0, null);
        }, 5);
        return true;
      }),
      removeAllListeners: mock(),
      pid: 4242,
    };
    return mockProcess;
  }),
}));

import { startDevServicesDashboard } from "../backend/index";
import type { DevUIServer } from "../backend/types";
import { run, type CliIO } from "./run";
import { EXIT } from "./exit-codes";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine a free port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describe("CLI", () => {
  let server: DevUIServer;
  let url: string;

  /** Runs a command against the live dashboard, capturing both streams. */
  async function cli(...args: string[]) {
    let stdout = "";
    let stderr = "";
    const io: CliIO = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      // No color, so assertions match plain strings.
      env: { NO_COLOR: "1" },
      isTTY: false,
      version: "9.9.9-test",
    };

    const code = await run(["--url", url, ...args], io);
    return { code, stdout, stderr };
  }

  beforeEach(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    server = await startDevServicesDashboard({
      port,
      hostname: "127.0.0.1",
      maxLogLines: 10,
      dashboardName: "CLI Test",
      services: [
        {
          id: "api",
          name: "API Server",
          command: ["node", "server.js"],
          signals: [{ label: "Reload", signal: "SIGHUP" }],
        },
      ],
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("status", () => {
    it("prints a table and exits 0", async () => {
      const { code, stdout } = await cli("status");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("SERVICE");
      expect(stdout).toContain("api");
      expect(stdout).toContain("stopped");
    });

    it("emits JSON on stdout under --json", async () => {
      const { code, stdout } = await cli("status", "--json");
      expect(code).toBe(EXIT.OK);

      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.services[0].id).toBe("api");
    });

    it("exits 4 for an unknown service, with nothing on stdout", async () => {
      const { code, stdout, stderr } = await cli("status", "nope");
      expect(code).toBe(EXIT.NO_SERVICE);
      expect(stdout).toBe("");
      expect(stderr).toContain("nope");
    });

    it("puts a --json error on stderr as parseable JSON", async () => {
      const { code, stdout, stderr } = await cli("status", "nope", "--json");
      expect(code).toBe(EXIT.NO_SERVICE);
      expect(stdout).toBe("");

      const parsed = JSON.parse(stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("service_not_found");
      expect(parsed.exitCode).toBe(EXIT.NO_SERVICE);
    });

    it("--check exits 3 when a service is not running", async () => {
      const { code } = await cli("status", "--check");
      expect(code).toBe(EXIT.FAILED);
    });

    it("--check exits 0 once everything is running", async () => {
      await cli("start", "api");
      const { code } = await cli("status", "--check");
      expect(code).toBe(EXIT.OK);
    });
  });

  describe("lifecycle", () => {
    it("starts, restarts, and stops a service", async () => {
      const started = await cli("start", "api");
      expect(started.code).toBe(EXIT.OK);
      expect(started.stdout).toContain("running");

      expect((await cli("restart", "api")).code).toBe(EXIT.OK);
      expect((await cli("stop", "api")).code).toBe(EXIT.OK);

      const { stdout } = await cli("status", "api", "--json");
      expect(JSON.parse(stdout).service.status).toBe("stopped");
    });

    it("start-all and stop-all report counts", async () => {
      const up = await cli("start-all");
      expect(up.code).toBe(EXIT.OK);
      expect(up.stdout).toContain("1/1");

      const down = await cli("stop-all");
      expect(down.code).toBe(EXIT.OK);
      expect(down.stdout).toContain("1/1");
    });

    it("requires a service id", async () => {
      const { code, stderr } = await cli("start");
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain("service id is required");
    });
  });

  describe("signals", () => {
    it("sends a declared signal", async () => {
      await cli("start", "api");
      const { code, stdout } = await cli("signal", "api", "SIGHUP");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("SIGHUP");
    });

    it("exits 7 for an undeclared signal", async () => {
      await cli("start", "api");
      const { code, stderr } = await cli("signal", "api", "SIGUSR2");
      expect(code).toBe(EXIT.SIGNAL_NOT_ALLOWED);
      expect(stderr).toContain("does not declare");
    });

    it("exits 3 when the service is not running", async () => {
      const { code } = await cli("signal", "api", "SIGHUP");
      expect(code).toBe(EXIT.FAILED);
    });

    it("requires a signal name", async () => {
      const { code } = await cli("signal", "api");
      expect(code).toBe(EXIT.USAGE);
    });
  });

  describe("logs", () => {
    it("prints lines with no blank padding between them", async () => {
      await cli("start", "api");

      const { code, stdout } = await cli("logs", "api");
      expect(code).toBe(EXIT.OK);

      const lines = stdout.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      // A log entry keeps its trailing newline in the buffer; rendering must not
      // turn that into a blank line between every entry.
      expect(stdout).not.toContain("\n\n");
      expect(lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    });

    it("--plain drops the timestamp prefix", async () => {
      await cli("start", "api");
      const { stdout } = await cli("logs", "api", "--plain");
      expect(stdout).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("rejects a bad --lines", async () => {
      const { code, stderr } = await cli("logs", "api", "--lines", "-4");
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain("--lines");
    });

    it("clears logs", async () => {
      await cli("start", "api");
      expect((await cli("clear-logs", "api")).code).toBe(EXIT.OK);
    });
  });

  describe("health and connectivity", () => {
    it("reports a healthy dashboard", async () => {
      const { code, stdout } = await cli("health");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("CLI Test");
    });

    it("exits 5 when nothing is listening", async () => {
      let stderr = "";
      const code = await run(["--url", "http://127.0.0.1:1", "health"], {
        stdout: () => {},
        stderr: (t) => {
          stderr += t;
        },
        env: {},
        isTTY: false,
        version: "9.9.9-test",
      });

      expect(code).toBe(EXIT.UNREACHABLE);
      expect(stderr).toContain("Could not reach");
    });
  });

  describe("argument handling", () => {
    const bare = async (...args: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await run(args, {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        env: {},
        isTTY: false,
        version: "9.9.9-test",
      });
      return { code, stdout, stderr };
    };

    it("shows root help with no arguments", async () => {
      const { code, stdout } = await bare();
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("Usage: dsd");
      expect(stdout).toContain("AGENT NOTES");
    });

    it("documents every exit code in the root help", async () => {
      const { stdout } = await bare("--help");
      for (const code of Object.values(EXIT)) {
        expect(stdout).toContain(String(code));
      }
    });

    it("prints the version", async () => {
      expect((await bare("--version")).stdout.trim()).toBe("9.9.9-test");
    });

    it("exits 2 on an unknown command", async () => {
      const { code, stderr } = await bare("frobnicate");
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain("unknown command");
    });

    it("exits 2 on an unknown flag", async () => {
      const { code } = await bare("status", "--wat");
      expect(code).toBe(EXIT.USAGE);
    });

    it("accepts flags before or after the command", async () => {
      const before = await cli("status");
      expect(before.code).toBe(EXIT.OK);

      // `run` is called directly here so --url lands after the command.
      let stdout = "";
      const code = await run(["status", "--url", url], {
        stdout: (t) => {
          stdout += t;
        },
        stderr: () => {},
        env: { NO_COLOR: "1" },
        isTTY: false,
        version: "9.9.9-test",
      });

      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("api");
    });

    it("reads the dashboard URL from the environment", async () => {
      let stdout = "";
      const code = await run(["status"], {
        stdout: (t) => {
          stdout += t;
        },
        stderr: () => {},
        env: { DSD_URL: url, NO_COLOR: "1" },
        isTTY: false,
        version: "9.9.9-test",
      });

      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("api");
    });

    it("emits a machine-readable manifest for help --json", async () => {
      const { code, stdout } = await bare("help", "--json");
      expect(code).toBe(EXIT.OK);

      const manifest = JSON.parse(stdout);
      expect(manifest.commands.length).toBeGreaterThan(5);
      expect(manifest.exitCodes["4"]).toBe("no such service");
      expect(manifest.commands.map((c: { name: string }) => c.name)).toContain(
        "start",
      );
    });

    it("shows per-command help", async () => {
      const { code, stdout } = await bare("logs", "--help");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("dsd logs");
      expect(stdout).toContain("--lines");
    });

    it("supports the status aliases", async () => {
      for (const alias of ["ls", "list", "ps"]) {
        const { code } = await cli(alias);
        expect(code).toBe(EXIT.OK);
      }
    });
  });
});

describe("CLI logs --follow", () => {
  let server: DevUIServer;
  let url: string;
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    server = await startDevServicesDashboard({
      port,
      hostname: "127.0.0.1",
      maxLogLines: 50,
      dashboardName: "Follow Test",
      services: [{ id: "api", name: "API Server", command: ["node", "x.js"] }],
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  /**
   * Runs a follow, then aborts it once `until` is satisfied (or a deadline
   * passes), so a streaming command can be asserted on without hanging.
   */
  async function follow(args: string[], until: (stdout: string) => boolean) {
    const controller = new AbortController();
    let stdout = "";
    let stderr = "";

    const done = run(["--url", url, ...args], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
      env: { NO_COLOR: "1" },
      isTTY: false,
      version: "9.9.9-test",
      signal: controller.signal,
    });

    const deadline = Date.now() + 3000;
    while (!until(stdout) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    controller.abort();

    return { code: await done, stdout, stderr };
  }

  it("replays the buffered tail and exits 0 when aborted", async () => {
    await run(["--url", url, "start", "api"], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      isTTY: false,
      version: "9.9.9-test",
    });

    const { code, stdout } = await follow(["logs", "api", "--follow"], (out) =>
      out.includes("started successfully"),
    );

    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("started successfully");
  });

  it("streams lines that arrive after it connects", async () => {
    // Nothing is buffered yet, so anything that shows up must have been pushed
    // live over the socket. Trigger the start once the follow is connected.
    setTimeout(() => {
      void run(["--url", url, "start", "api"], {
        stdout: () => {},
        stderr: () => {},
        env: {},
        isTTY: false,
        version: "9.9.9-test",
      });
    }, 200);

    const { code, stdout } = await follow(["logs", "api", "--follow"], (out) =>
      out.includes("Attempting to start"),
    );

    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("Attempting to start");
  });

  it("emits NDJSON under --json, one entry per line", async () => {
    await run(["--url", url, "start", "api"], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      isTTY: false,
      version: "9.9.9-test",
    });

    const { stdout } = await follow(
      ["logs", "api", "--follow", "--json"],
      (out) => out.split("\n").filter(Boolean).length > 0,
    );

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(typeof entry.timestamp).toBe("number");
      expect(["stdout", "stderr", "system"]).toContain(entry.logType);
    }
  });

  it("exits 4 when following an unknown service", async () => {
    const { code, stderr } = await follow(
      ["logs", "nope", "--follow"],
      () => false,
    );
    expect(code).toBe(EXIT.NO_SERVICE);
    expect(stderr).toContain("nope");
  });

  it("exits 5 when the dashboard is not reachable", async () => {
    const controller = new AbortController();
    let stderr = "";
    const code = await run(
      ["--url", "http://127.0.0.1:1", "logs", "api", "-f"],
      {
        stdout: () => {},
        stderr: (t) => {
          stderr += t;
        },
        env: {},
        isTTY: false,
        version: "9.9.9-test",
        signal: controller.signal,
      },
    );

    expect(code).toBe(EXIT.UNREACHABLE);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("exits 5 when the dashboard goes away mid-follow", async () => {
    const controller = new AbortController();
    let stdout = "";
    const done = run(["--url", url, "logs", "api", "-f"], {
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      env: { NO_COLOR: "1" },
      isTTY: false,
      version: "9.9.9-test",
      signal: controller.signal,
    });

    // Let the socket connect and take the initial_state frame.
    await new Promise((r) => setTimeout(r, 150));
    await server.stop();

    expect(await done).toBe(EXIT.UNREACHABLE);
    void stdout;

    // afterEach stops it again; stop() is safe to call twice.
  });

  it("rejects --since together with --follow", async () => {
    const controller = new AbortController();
    let stderr = "";
    const code = await run(
      ["--url", url, "logs", "api", "-f", "--since", "123"],
      {
        stdout: () => {},
        stderr: (t) => {
          stderr += t;
        },
        env: {},
        isTTY: false,
        version: "9.9.9-test",
        signal: controller.signal,
      },
    );

    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("--since");
  });

  it("rejects an unknown --type", async () => {
    const controller = new AbortController();
    let stderr = "";
    const code = await run(
      ["--url", url, "logs", "api", "-f", "--type", "banana"],
      {
        stdout: () => {},
        stderr: (t) => {
          stderr += t;
        },
        env: {},
        isTTY: false,
        version: "9.9.9-test",
        signal: controller.signal,
      },
    );

    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("--type");
  });
});
