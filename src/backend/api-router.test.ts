import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createServer } from "net";

// Mock child_process so services "spawn" without launching anything real. The
// fake process reports a successful spawn on the next tick, which is what drives
// a service to `running`.
//
// The manager spawns two kinds of child, and they exit differently: a service
// command runs until something kills it, while the escaped-descendant sweep's
// `ps` is a one-shot that exits on its own. A stub that only ever exits from
// `kill()` models the first and hangs as the second, leaving every force-stop
// here to wait out the sweep's 2s guard. Reporting a clean, empty `ps` keeps
// these tests off that path (the guard itself is covered in
// service-manager.test.ts, which drives `ps` deliberately).
mock.module("child_process", () => ({
  spawn: mock((cmd: string) => {
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
    // No stdout, so the sweep parses an empty table and finds no descendants.
    if (cmd === "ps") {
      setTimeout(() => {
        for (const cb of listeners.close ?? []) cb(0, null);
      }, 0);
    }
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

    it("force-stops a service", async () => {
      await postJSON("/services/api/start");

      const res = await postJSON("/services/api/stop", { force: true });
      expect(res.status).toBe(200);
      expect((await res.json()).service.status).toBe("stopped");
    });

    it("rejects a non-boolean force", async () => {
      const res = await postJSON("/services/api/stop", { force: "yes" });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
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

    it("accepts a graceMs override on stop and restart", async () => {
      await postJSON("/services/api/start");
      expect(
        (await postJSON("/services/api/stop", { graceMs: 50 })).status,
      ).toBe(200);
      expect(
        (await postJSON("/services/api/restart", { graceMs: 50 })).status,
      ).toBe(200);
    });

    it("rejects a non-positive or non-integer graceMs", async () => {
      for (const graceMs of [0, -5, 1.5, "500"]) {
        const res = await postJSON("/services/api/stop", { graceMs });
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe("bad_request");
      }
    });

    it("force-stops every service via stop-all", async () => {
      await postJSON("/start-all");

      const res = await postJSON("/stop-all", { force: true });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.stopped).toBe(2);
      expect(
        body.services.every((s: { status: string }) => s.status === "stopped"),
      ).toBe(true);
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
      // The tail, not the head: the newest line is what "the last one" means.
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

    it("pages with cursor, including entries that share a millisecond", async () => {
      await postJSON("/services/api/start");

      const all = await (await fetch(`${base}/services/api/logs`)).json();
      const entries: { seq: number; timestamp: number }[] = all.entries;
      expect(entries.length).toBeGreaterThan(1);

      // Strictly increasing, which is what makes it a cursor. Not necessarily
      // gap-free within one service's buffer: the counter spans the dashboard,
      // so another service's lines take numbers in between.
      expect(
        entries.every((e, i) => i === 0 || e.seq > entries[i - 1].seq),
      ).toBe(true);
      // The cursor carries the run that issued it as well as the entry it
      // stopped at, since sequence numbers repeat after a restart.
      expect(all.nextCursor).toMatch(
        new RegExp(`^[0-9a-f]+:${entries[entries.length - 1].seq}$`),
      );

      const epoch = String(all.nextCursor).split(":")[0];
      const rest = await (
        await fetch(
          `${base}/services/api/logs?cursor=${epoch}:${entries[0].seq}`,
        )
      ).json();
      expect(rest.entries).toEqual(entries.slice(1));

      // The point of the cursor: `since` is millisecond-resolution, so any
      // entry sharing the first one's timestamp is lost to a `since` poller
      // but survives a `cursor` one.
      const bySince = await (
        await fetch(`${base}/services/api/logs?since=${entries[0].timestamp}`)
      ).json();
      expect(rest.entries.length).toBeGreaterThanOrEqual(
        bySince.entries.length,
      );

      // Polling at the reported cursor yields nothing new and doesn't rewind.
      const caughtUp = await (
        await fetch(`${base}/services/api/logs?cursor=${all.nextCursor}`)
      ).json();
      expect(caughtUp.entries).toHaveLength(0);
      expect(caughtUp.nextCursor).toBe(all.nextCursor);
    });

    it("pages past a limit smaller than the backlog, losing nothing", async () => {
      await postJSON("/services/api/start");

      const all = await (await fetch(`${base}/services/api/logs`)).json();
      const seqs: number[] = all.entries.map((e: { seq: number }) => e.seq);
      expect(seqs.length).toBeGreaterThan(1);
      expect(all.truncated).toBe(false);

      // One entry per page, so every page but the last holds entries back. The
      // cursor must stop at what it delivered rather than jumping to the newest
      // buffered entry, which would skip the backlog with nothing to warn the
      // caller (the buffer evicted nothing).
      const seen: number[] = [];
      // `0` is the one cursor a caller can write by hand: the oldest buffered
      // entry, in whichever run answers. Every later page carries the token the
      // previous one reported.
      let cursor = "0";
      let cursorSeq = 0;
      for (let i = 0; i < seqs.length + 5; i++) {
        const page = await (
          await fetch(`${base}/services/api/logs?cursor=${cursor}&limit=1`)
        ).json();
        if (page.entries.length === 0) break;
        // Forward, oldest first: a paging caller reads the head, not the tail.
        seen.push(...page.entries.map((e: { seq: number }) => e.seq));
        const seq = Number(String(page.nextCursor).split(":")[1]);
        expect(seq).toBeGreaterThan(cursorSeq);
        cursor = page.nextCursor;
        cursorSeq = seq;
      }

      expect(seen).toEqual(seqs);
    });

    it("keeps issuing fresh sequence numbers after a clear", async () => {
      await postJSON("/services/api/start");
      const before = await (await fetch(`${base}/services/api/logs`)).json();

      await fetch(`${base}/services/api/logs`, { method: "DELETE" });

      const after = await (await fetch(`${base}/services/api/logs`)).json();
      // The counter is never reset, so a poller holding the pre-clear cursor
      // still sees the line the clear itself wrote.
      const seqOf = (cursor: string) => Number(cursor.split(":")[1]);
      expect(seqOf(after.nextCursor)).toBeGreaterThan(seqOf(before.nextCursor));
      const fresh = await (
        await fetch(`${base}/services/api/logs?cursor=${before.nextCursor}`)
      ).json();
      expect(fresh.entries).toEqual(after.entries);
      // Clearing threw lines away that the poller may never have read, which
      // is what `truncated` is for. The system line the clear writes is no
      // substitute: a poller filtering on stdout/stderr never sees it.
      expect(fresh.truncated).toBe(true);
    });

    it("serves the buffer from the start for a cursor from an earlier run", async () => {
      await postJSON("/services/api/start");

      const all = await (await fetch(`${base}/services/api/logs`)).json();
      const seqs: number[] = all.entries.map((e: { seq: number }) => e.seq);
      expect(seqs.length).toBeGreaterThan(1);

      // What a poller holds after the dashboard restarts. The sequence lives on
      // the ServiceManager and begins again at 1, so such a cursor names a
      // number this run has *also* issued: honouring it would drop every entry
      // below it and, since nothing here was evicted, report `truncated: false`
      // while doing it. The epoch is what makes it recognisable.
      const stale = await (
        await fetch(`${base}/services/api/logs?cursor=earlierrun:${seqs[0]}`)
      ).json();

      expect(stale.entries).toEqual(all.entries);
      expect(stale.nextCursor).toBe(all.nextCursor);
      expect(stale.truncated).toBe(true);
    });

    it("rejects a cursor that is a bare number other than 0", async () => {
      // A client from before cursors carried an epoch, or a hand-written guess.
      // Reading it as a `seq` of this run is the silent-loss case above, so it
      // fails loudly instead.
      const res = await fetch(`${base}/services/api/logs?cursor=3`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");

      // The last two are digits no counter ever reaches: read as numbers they
      // lose precision, or become `Infinity`, and would come back out in
      // `nextCursor` as a token the next poll rejects.
      for (const bad of [
        "abc",
        ":4",
        "run:",
        "run:x",
        `run:${"9".repeat(400)}`,
        "run:9007199254740993",
      ]) {
        const rejected = await fetch(
          `${base}/services/api/logs?cursor=${encodeURIComponent(bad)}`,
        );
        expect(rejected.status).toBe(400);
      }

      // Including under this run's own epoch, where an out-of-range `seq`
      // against an empty buffer used to fall through into `nextCursor`.
      const empty = await (await fetch(`${base}/services/worker/logs`)).json();
      expect(empty.entries).toHaveLength(0);
      const epoch = String(empty.nextCursor).split(":")[0];
      const overflowed = await fetch(
        `${base}/services/worker/logs?cursor=${epoch}:${"9".repeat(400)}`,
      );
      expect(overflowed.status).toBe(400);
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
    // The legacy shape has no status field; the UI gets that over the socket.
    expect(body.services[0].status).toBeUndefined();
  });
});
