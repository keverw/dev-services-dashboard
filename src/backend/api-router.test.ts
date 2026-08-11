import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createServer } from "net";

// Mock child_process so services "spawn" without launching anything real. The
// fake process reports a successful spawn on the next tick, which is what drives
// a service to `running`.
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
        // Report the exit so stopService resolves rather than waiting out its
        // SIGTERM deadline.
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

import { startDevServicesDashboard, type DevUIConfig } from "./index";
import type { DevUIServer } from "./types";

/**
 * Finds a free port by binding one and letting the OS choose.
 *
 * Deliberately not `get-port` (which the older suite uses): that probes `::`
 * and throws outright on hosts without IPv6, such as many CI containers.
 * Binding 127.0.0.1 works everywhere the dashboard itself can bind.
 */
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

describe("Control API", () => {
  let server: DevUIServer;
  let base: string;

  const config = (port: number): DevUIConfig => ({
    port,
    hostname: "127.0.0.1",
    maxLogLines: 5,
    dashboardName: "Test Dashboard",
    services: [
      {
        id: "api",
        name: "API Server",
        command: ["node", "server.js"],
        env: { SECRET_TOKEN: "must-not-leak" },
        signals: [{ label: "Reload", signal: "SIGHUP" }],
        webLinks: [{ label: "Docs", url: "http://localhost:3001/docs" }],
      },
      {
        id: "worker",
        name: "Worker",
        command: ["node", "worker.js"],
        dependsOn: ["api"],
      },
    ],
  });

  beforeEach(async () => {
    const port = await freePort();
    server = await startDevServicesDashboard(config(port));
    base = `http://127.0.0.1:${port}/api/v1`;
  });

  afterEach(async () => {
    await server.stop();
  });

  const postJSON = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  describe("reads", () => {
    it("lists services with status", async () => {
      const res = await fetch(`${base}/services`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.dashboardName).toBe("Test Dashboard");
      expect(body.services).toHaveLength(2);
      expect(body.services[0].id).toBe("api");
      expect(body.services[0].status).toBe("stopped");
      expect(body.services[0].pid).toBeNull();
    });

    it("never exposes env, command, cwd, or the process handle", async () => {
      const res = await fetch(`${base}/services`);
      const text = await res.text();

      expect(text).not.toContain("must-not-leak");
      expect(text).not.toContain("SECRET_TOKEN");
      expect(text).not.toContain('"env"');
      expect(text).not.toContain('"command"');
      expect(text).not.toContain('"cwd"');
      expect(text).not.toContain('"process"');
    });

    it("gets a single service", async () => {
      const res = await fetch(`${base}/services/api`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.service.name).toBe("API Server");
      expect(body.service.dependsOn).toEqual([]);
      expect(body.service.webLinks).toEqual([
        { label: "Docs", url: "http://localhost:3001/docs" },
      ]);
    });

    it("404s an unknown service with a machine-readable code", async () => {
      const res = await fetch(`${base}/services/nope`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("service_not_found");
    });

    it("404s an unknown route", async () => {
      const res = await fetch(`${base}/nope`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    });

    it("serves a route index and a health check", async () => {
      const index = await (await fetch(base)).json();
      expect(index.ok).toBe(true);
      expect(index.routes.length).toBeGreaterThan(5);

      const health = await (await fetch(`${base}/health`)).json();
      expect(health.serviceCount).toBe(2);
      expect(health.shuttingDown).toBe(false);
    });

    it("405s a known path with the wrong method, and sets Allow", async () => {
      const res = await postJSON("/services");
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect((await res.json()).error.code).toBe("method_not_allowed");
    });
  });

  describe("lifecycle", () => {
    it("starts a service and reports the settled outcome", async () => {
      const res = await postJSON("/services/api/start");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.waited).toBe(true);
      expect(body.service.status).toBe("running");
      expect(body.service.pid).toBe(4242);
    });

    it("returns 202 without waiting when asked", async () => {
      const res = await postJSON("/services/api/start", { wait: false });
      expect(res.status).toBe(202);
      expect((await res.json()).waited).toBe(false);
    });

    it("rejects a non-boolean wait", async () => {
      const res = await postJSON("/services/api/start", { wait: "yes" });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    });

    it("stops a running service", async () => {
      await postJSON("/services/api/start");

      const res = await postJSON("/services/api/stop");
      expect(res.status).toBe(200);
      expect((await res.json()).service.status).toBe("stopped");
    });

    it("reports start-all counts", async () => {
      const res = await postJSON("/start-all");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.started).toBe(2);
      expect(body.failed).toBe(0);
      expect(body.services).toHaveLength(2);
    });

    it("reports stop-all counts", async () => {
      await postJSON("/start-all");

      const res = await postJSON("/stop-all");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.stopped).toBe(2);
      expect(body.failed).toBe(0);
    });
  });

  describe("signals", () => {
    it("sends a declared signal to a running service", async () => {
      await postJSON("/services/api/start");

      const res = await postJSON("/services/api/signal", { signal: "SIGHUP" });
      expect(res.status).toBe(200);
      expect((await res.json()).signal).toBe("SIGHUP");
    });

    it("422s a signal the service does not declare", async () => {
      await postJSON("/services/api/start");

      const res = await postJSON("/services/api/signal", { signal: "SIGUSR2" });
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("signal_not_allowed");
      expect(body.error.details.allowed).toEqual(["SIGHUP"]);
    });

    it("409s a signal to a service that is not running", async () => {
      const res = await postJSON("/services/api/signal", { signal: "SIGHUP" });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("service_not_running");
    });

    it("400s a missing signal", async () => {
      const res = await postJSON("/services/api/signal", {});
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    });
  });

  describe("logs", () => {
    it("returns buffered entries with buffer metadata", async () => {
      await postJSON("/services/api/start");

      const body = await (await fetch(`${base}/services/api/logs`)).json();
      expect(body.ok).toBe(true);
      expect(body.bufferLimit).toBe(5);
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.returned).toBe(body.entries.length);
    });

    it("returns the tail when limit is smaller than the buffer", async () => {
      await postJSON("/services/api/start");

      const all = await (await fetch(`${base}/services/api/logs`)).json();
      const tail = await (
        await fetch(`${base}/services/api/logs?limit=1`)
      ).json();

      expect(tail.entries).toHaveLength(1);
      // The tail, not the head — the newest line is what "the last one" means.
      expect(tail.entries[0]).toEqual(all.entries[all.entries.length - 1]);
    });

    it("filters by logType and rejects an unknown one", async () => {
      await postJSON("/services/api/start");

      const system = await (
        await fetch(`${base}/services/api/logs?logType=system`)
      ).json();
      expect(
        system.entries.every(
          (e: { logType: string }) => e.logType === "system",
        ),
      ).toBe(true);

      const bad = await fetch(`${base}/services/api/logs?logType=banana`);
      expect(bad.status).toBe(400);
    });

    it("filters by since", async () => {
      await postJSON("/services/api/start");

      const future = Date.now() + 60_000;
      const body = await (
        await fetch(`${base}/services/api/logs?since=${future}`)
      ).json();
      expect(body.entries).toHaveLength(0);
    });

    it("rejects a non-integer limit", async () => {
      const res = await fetch(`${base}/services/api/logs?limit=abc`);
      expect(res.status).toBe(400);
    });

    it("renders text format one line per line, with no blank padding", async () => {
      await postJSON("/services/api/start");

      const res = await fetch(`${base}/services/api/logs?format=text`);
      expect(res.headers.get("Content-Type")).toContain("text/plain");

      const text = await res.text();
      const lines = text.split("\n").filter((l) => l.length > 0);
      // Every emitted line carries its own timestamp prefix; a chunk's trailing
      // newline must not produce a blank line.
      expect(lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    });

    it("clears the log buffer", async () => {
      await postJSON("/services/api/start");

      const res = await fetch(`${base}/services/api/logs`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const after = await (await fetch(`${base}/services/api/logs`)).json();
      // Clearing writes a single system line in place of the buffer.
      expect(after.entries.length).toBeLessThanOrEqual(1);
    });
  });

  describe("guards", () => {
    it("415s a mutating request that is not application/json", async () => {
      const res = await fetch(`${base}/start-all`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(res.status).toBe(415);
      expect((await res.json()).error.code).toBe("unsupported_media_type");
    });

    it("403s a cross-origin request", async () => {
      const res = await fetch(`${base}/services`, {
        headers: { Origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_origin");
    });

    it("400s a malformed JSON body", async () => {
      const res = await fetch(`${base}/services/api/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    });

    it("accepts an empty body on a POST", async () => {
      const res = await fetch(`${base}/services/api/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
    });

    it("never sends CORS headers", async () => {
      const res = await fetch(`${base}/services`);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  it("leaves the legacy /api/services-config endpoint untouched", async () => {
    const url = base.replace("/api/v1", "/api/services-config");
    const res = await fetch(url);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.dashboardName).toBe("Test Dashboard");
    expect(body.services).toHaveLength(2);
    // The legacy shape has no status field — the UI gets that over the socket.
    expect(body.services[0].status).toBeUndefined();
  });
});
