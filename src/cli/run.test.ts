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
import { run, resolveTimeoutForTest, type CliIO } from "./run";
import {
  ABORT_REASON,
  EXIT,
  finalExitCode,
  type AbortReason,
} from "./exit-codes";

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

    it("stop --force works and reports the service stopped", async () => {
      await cli("start", "api");

      const { code, stdout } = await cli("stop", "api", "--force");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("stopped");

      const detail = await cli("status", "api", "--json");
      expect(JSON.parse(detail.stdout).service.status).toBe("stopped");
    });

    it("accepts --grace on stop, restart, and stop-all", async () => {
      await cli("start", "api");
      expect((await cli("stop", "api", "--grace", "50")).code).toBe(EXIT.OK);
      expect((await cli("restart", "api", "--grace", "50")).code).toBe(EXIT.OK);
      expect((await cli("stop-all", "--grace", "50")).code).toBe(EXIT.OK);
    });

    it("rejects a non-positive --grace, pointing at --force", async () => {
      // `--grace=<value>` rather than a separate argument: parseArgs rejects a
      // dash-leading value as ambiguous before our own validation sees it (also
      // exit 2, just a different message).
      for (const value of ["0", "-1", "1.5", "abc"]) {
        const { code, stderr } = await cli("stop", "api", `--grace=${value}`);
        expect(code).toBe(EXIT.USAGE);
        expect(stderr).toContain("--force");
      }
    });

    it("stop-all --force works", async () => {
      await cli("start-all");
      const { code, stdout } = await cli("stop-all", "--force");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("1/1");
    });

    it("documents --force under `stop --help`", async () => {
      const { code, stdout } = await cli("stop", "--help");
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("--force");
      expect(stdout).toContain("SIGKILL");
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

    it("applies no client deadline to the lifecycle commands", async () => {
      // A stop waits out the service's configurable `stopTimeout` before
      // escalating to SIGKILL, and a start can run for the sum of the three
      // start windows. A default client deadline on either would abort the
      // request and report a failure while the server was still working.
      for (const command of [
        "start",
        "stop",
        "restart",
        "start-all",
        "stop-all",
      ]) {
        expect(resolveTimeoutForTest(command)).toBe(0);
      }
      expect(resolveTimeoutForTest("status")).toBeGreaterThan(0);
      expect(resolveTimeoutForTest("logs")).toBeGreaterThan(0);
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

    it("rejects a bad --cursor", async () => {
      const { code, stderr } = await cli("logs", "api", "--cursor", "1.5");
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain("--cursor");
    });

    it("--cursor pages forward from a previous nextCursor", async () => {
      await cli("start", "api");

      const first = JSON.parse((await cli("logs", "api", "--json")).stdout);
      expect(first.entries.length).toBeGreaterThan(0);

      const caughtUp = JSON.parse(
        (await cli("logs", "api", "--json", "--cursor", `${first.nextCursor}`))
          .stdout,
      );
      expect(caughtUp.entries).toHaveLength(0);
      expect(caughtUp.nextCursor).toBe(first.nextCursor);

      // From the very start, one entry per page: the head, not the tail, so a
      // poller collects the backlog instead of jumping to the newest line.
      const page = JSON.parse(
        (await cli("logs", "api", "--json", "--cursor", "0", "--lines", "1"))
          .stdout,
      );
      expect(page.entries).toEqual([first.entries[0]]);
    });

    it("clears logs", async () => {
      await cli("start", "api");
      expect((await cli("clear-logs", "api")).code).toBe(EXIT.OK);
    });
  });

  describe("interrupts", () => {
    /** Runs a command whose interrupt signal is already aborted (Ctrl+C). */
    async function interrupted(...args: string[]) {
      const controller = new AbortController();
      controller.abort();

      let stdout = "";
      let stderr = "";
      const code = await run(["--url", url, ...args], {
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
      return { code, stdout, stderr };
    }

    it("exits 130 when a command is cut short, not 5", async () => {
      // The distinction is the point: 5 means "no dashboard there", which is a
      // very different thing for a retrying script than "you pressed Ctrl+C".
      const { code, stdout } = await interrupted("start", "api");
      expect(code).toBe(EXIT.INTERRUPTED);
      expect(code).not.toBe(EXIT.UNREACHABLE);
      expect(stdout).toBe("");
    });

    it("reports an interrupt distinctly under --json", async () => {
      const { code, stderr } = await interrupted("status", "--json");
      expect(code).toBe(EXIT.INTERRUPTED);

      const parsed = JSON.parse(stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("interrupted");
      // The envelope's exitCode must agree with what the process actually
      // returns, or a script branching on the JSON disagrees with `$?`.
      expect(parsed.exitCode).toBe(EXIT.INTERRUPTED);
    });

    it("interrupts a request that is already in flight", async () => {
      // The case the fix actually exists for: Ctrl+C partway through a blocking
      // command, not before it started. A server that accepts the connection
      // and never answers stands in for a slow `stop`, so the abort has to
      // reach the pending fetch rather than the pre-flight guard.
      const silent = createServer();
      silent.on("connection", () => {}); // accept, then never respond
      const port = await new Promise<number>((resolve) => {
        silent.listen(0, "127.0.0.1", () => {
          resolve((silent.address() as { port: number }).port);
        });
      });

      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        let stderr = "";
        const code = await run(
          ["--url", `http://127.0.0.1:${port}`, "stop", "api"],
          {
            stdout: () => {},
            stderr: (t) => {
              stderr += t;
            },
            env: { NO_COLOR: "1" },
            isTTY: false,
            version: "9.9.9-test",
            signal: controller.signal,
          },
        );

        // Not UNREACHABLE: the dashboard answered the connection fine, and not
        // a timeout either, since `stop` carries no client deadline.
        expect(code).toBe(EXIT.INTERRUPTED);
        expect(stderr).toContain("Interrupted");
        expect(stderr).not.toContain("Timed out");
      } finally {
        await new Promise((r) => silent.close(() => r(null)));
      }
    });

    it("documents 130 in the help table", async () => {
      const { stdout } = await cli("--help");
      expect(stdout).toContain("130 interrupted before completing");
    });

    describe("finalExitCode", () => {
      it("keeps a completed command's own code despite a signal", () => {
        // `logs --follow` ending on Ctrl+C is a success, not a 130.
        expect(finalExitCode(EXIT.OK, 130)).toBe(EXIT.OK);
      });

      it("reports the signal's code when the command did not complete", () => {
        expect(finalExitCode(EXIT.UNREACHABLE, 130)).toBe(130);
        expect(finalExitCode(EXIT.INTERRUPTED, 143)).toBe(143);
      });

      it("passes the command's code straight through with no signal", () => {
        expect(finalExitCode(EXIT.OK)).toBe(EXIT.OK);
        expect(finalExitCode(EXIT.FAILED)).toBe(EXIT.FAILED);
      });
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

    describe("rejects flags and arguments the command doesn't take", () => {
      it("exits 2 on a flag that belongs to another command", async () => {
        // The case that motivated this: --no-wait is real, and a stop that
        // silently ignored it would block for the full grace period while the
        // caller believed it had asked not to wait.
        const { code, stderr } = await bare("stop", "api", "--no-wait");
        expect(code).toBe(EXIT.USAGE);
        expect(stderr).toContain('"--no-wait" is not an option of "dsd stop"');

        expect((await bare("status", "--force")).code).toBe(EXIT.USAGE);
        expect((await bare("health", "-f")).code).toBe(EXIT.USAGE);
      });

      it("still accepts a command's own flags and the global ones", async () => {
        await cli("start", "api");
        expect((await cli("status", "--check", "--json")).code).toBe(EXIT.OK);
        expect((await cli("logs", "api", "-n", "1", "--plain")).code).toBe(
          EXIT.OK,
        );
        expect((await cli("stop", "api", "--force")).code).toBe(EXIT.OK);
      });

      it("exits 2 on a surplus positional", async () => {
        const { code, stderr } = await bare("start", "api", "extra");
        expect(code).toBe(EXIT.USAGE);
        expect(stderr).toContain('unexpected argument "extra"');

        // A command that takes none at all, and one that takes exactly two.
        expect((await bare("start-all", "api")).code).toBe(EXIT.USAGE);
        expect((await bare("signal", "api", "SIGHUP", "again")).code).toBe(
          EXIT.USAGE,
        );
      });

      it("keeps the specific message for a missing argument", async () => {
        // Arity checking must not pre-empt these: "a service id is required"
        // tells the user what to type, "takes 1 argument" doesn't.
        expect((await bare("logs")).stderr).toContain(
          "a service id is required",
        );
        expect((await bare("signal", "api")).stderr).toContain(
          "a signal name is required",
        );
      });
    });

    describe("--json keeps errors machine-readable", () => {
      /** Parses a JSON error envelope, asserting it agrees with the exit code. */
      function envelope(stderr: string, code: number) {
        const parsed = JSON.parse(stderr);
        expect(parsed.ok).toBe(false);
        expect(parsed.exitCode).toBe(code);
        return parsed;
      }

      it("reports a parse failure as JSON, not as a bare sentence", async () => {
        // The path that has no parsed --json to consult: the parse is what
        // failed. A caller that always parses stderr must not choke here.
        const { code, stderr } = await bare("status", "--json", "--wat");
        expect(code).toBe(EXIT.USAGE);
        expect(envelope(stderr, EXIT.USAGE).error.code).toBe("usage");
      });

      it("reports local validation failures as JSON", async () => {
        for (const args of [
          ["start", "--json"], // missing service id
          ["stop", "api", "--json", "--grace", "0"],
          ["logs", "api", "--json", "--lines", "-1"],
          ["logs", "api", "--json", "--follow", "--since", "1"],
          ["signal", "api", "--json"],
          ["frobnicate", "--json"],
          ["status", "--json", "--timeout", "abc"],
        ]) {
          const { code, stderr } = await bare(...args);
          expect(code).toBe(EXIT.USAGE);
          expect(envelope(stderr, EXIT.USAGE).error.code).toBe("usage");
        }
      });

      it("leaves stdout clean when an error is reported", async () => {
        const { stdout } = await bare("start", "--json");
        expect(stdout).toBe("");
      });

      it("still prints plain text without --json", async () => {
        const { stderr } = await bare("start");
        expect(stderr).toBe("dsd: a service id is required.\n");
      });
    });

    describe("--version is global", () => {
      it("wins over a command that would otherwise run", async () => {
        // `bare` has no --url, so a `status` that actually ran would go looking
        // for a dashboard on the default port and exit 5.
        const { code, stdout } = await bare("status", "--version");
        expect(code).toBe(EXIT.OK);
        expect(stdout.trim()).toBe("9.9.9-test");

        // Including against a live one, where a run would have succeeded.
        const live = await cli("status", "--version");
        expect(live.stdout.trim()).toBe("9.9.9-test");
        expect(live.stdout).not.toContain("SERVICE");
      });

      it("renders the same as the version command", async () => {
        for (const args of [
          ["--version"],
          ["version"],
          ["status", "--version"],
          ["status", "-v"],
        ]) {
          expect((await bare(...args)).stdout.trim()).toBe("9.9.9-test");
          expect(JSON.parse((await bare(...args, "--json")).stdout)).toEqual({
            ok: true,
            version: "9.9.9-test",
          });
        }
      });

      it("still reports an unknown command rather than the version", async () => {
        // The invocation is checked first; a version for a command that doesn't
        // exist would hide the typo it was asked about.
        const { code } = await bare("frobnicate", "--version");
        expect(code).toBe(EXIT.USAGE);
      });
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
  async function follow(
    args: string[],
    until: (stdout: string) => boolean,
    abortReason?: AbortReason,
  ) {
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
    controller.abort(abortReason);

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

  it("does not report success when SIGTERM ends the follow", async () => {
    // Ctrl+C is the documented way to end a follow, so it exits 0. A SIGTERM is
    // a supervisor killing the process, and reporting that as a clean finish
    // would tell the supervisor its child shut down on purpose.
    await run(["--url", url, "start", "api"], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      isTTY: false,
      version: "9.9.9-test",
    });

    const { code } = await follow(
      ["logs", "api", "--follow"],
      (out) => out.includes("started successfully"),
      ABORT_REASON.SIGTERM,
    );

    expect(code).not.toBe(EXIT.OK);
    // `bin.ts` turns any non-zero here into the signal's own 143.
    expect(finalExitCode(code, 143)).toBe(143);
    expect(finalExitCode(EXIT.OK, 130)).toBe(EXIT.OK);
  });

  it("says nothing when aborted mid-handshake", async () => {
    // Closing a socket that is still connecting makes `ws` emit an `error`
    // after the fact. That arrives once the follow has already finished, so
    // reporting it would put an `unreachable` failure on stderr under an exit
    // code of 0, and a caller reading either signal alone would get a different
    // answer. Abort with no delay at all, so the abort is in flight while the
    // handshake is.
    for (const args of [
      ["logs", "api", "--follow"],
      ["logs", "api", "--follow", "--json"],
    ]) {
      const controller = new AbortController();
      let stderr = "";
      const done = run(["--url", url, ...args], {
        stdout: () => {},
        stderr: (t) => {
          stderr += t;
        },
        env: { NO_COLOR: "1" },
        isTTY: false,
        version: "9.9.9-test",
        signal: controller.signal,
      });
      controller.abort();

      expect(await done).toBe(EXIT.OK);
      // Give the socket time to emit its post-close error, which would land
      // after the promise had already resolved.
      await new Promise((r) => setTimeout(r, 200));
      expect(stderr).toBe("");
    }
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

  describe("--json failures stay parseable", () => {
    it("reports an unknown service as JSON", async () => {
      const { code, stderr } = await follow(
        ["logs", "nope", "--follow", "--json"],
        () => false,
      );

      expect(code).toBe(EXIT.NO_SERVICE);
      const parsed = JSON.parse(stderr);
      expect(parsed.ok).toBe(false);
      // The same code the HTTP routes use, so a caller needs no follow-only case.
      expect(parsed.error.code).toBe("service_not_found");
      expect(parsed.exitCode).toBe(EXIT.NO_SERVICE);
    });

    it("reports an unreachable dashboard as JSON", async () => {
      let stderr = "";
      const code = await run(
        ["--url", "http://127.0.0.1:1", "logs", "api", "-f", "--json"],
        {
          stdout: () => {},
          stderr: (t) => {
            stderr += t;
          },
          env: {},
          isTTY: false,
          version: "9.9.9-test",
          signal: new AbortController().signal,
        },
      );

      expect(code).toBe(EXIT.UNREACHABLE);
      const parsed = JSON.parse(stderr);
      expect(parsed.error.code).toBe("unreachable");
      expect(parsed.exitCode).toBe(EXIT.UNREACHABLE);
    });

    it("reports the dashboard going away mid-follow as JSON", async () => {
      let stdout = "";
      let stderr = "";
      const done = run(["--url", url, "logs", "api", "-f", "--json"], {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        env: { NO_COLOR: "1" },
        isTTY: false,
        version: "9.9.9-test",
        signal: new AbortController().signal,
      });

      await new Promise((r) => setTimeout(r, 150));
      await server.stop();

      expect(await done).toBe(EXIT.UNREACHABLE);
      // The last line, since a status notice may precede it on the way down.
      const lines = stderr.split("\n").filter(Boolean);
      expect(JSON.parse(lines[lines.length - 1]).error.code).toBe(
        "unreachable",
      );
      // stdout is NDJSON and must not have picked up the failure.
      for (const line of stdout.split("\n").filter(Boolean)) {
        expect(JSON.parse(line).ok).toBeUndefined();
      }
    });
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

  it("rejects --cursor together with --follow", async () => {
    const controller = new AbortController();
    let stderr = "";
    const code = await run(
      ["--url", url, "logs", "api", "-f", "--cursor", "1"],
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
    expect(stderr).toContain("--cursor");
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
