import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  spyOn,
} from "bun:test";

// --- Controllable child_process mock ----------------------------------------

interface MockStream {
  on: (event: string, cb: (data: Buffer) => void) => void;
  emit: (data: Buffer) => void;
}

interface MockProcess {
  pid: number;
  spawnArgs?: { cmd: string; args: string[]; opts: Record<string, unknown> };
  exitOnSignals: Set<string>;
  on: (event: string, cb: (...args: unknown[]) => void) => MockProcess;
  removeAllListeners: (event?: string) => MockProcess;
  emit: (event: string, ...args: unknown[]) => void;
  stdout: MockStream;
  stderr: MockStream;
  kill: (signal?: string) => boolean;
}

// A minimal stdout/stderr stream that captures its "data" handler so tests can
// push output through it.
function makeStream(): MockStream {
  let cb: ((data: Buffer) => void) | null = null;
  return {
    on(event, fn) {
      if (event === "data") cb = fn;
    },
    emit(data) {
      cb?.(data);
    },
  };
}

// Records every spawned process and every kill() call so tests can make
// assertions about ordering and signals.
const spawnedProcesses: MockProcess[] = [];
const killLog: Array<{ cmd: string; signal: string | undefined }> = [];
// Maps each mock process's (unique) pid to itself, so the process.kill spy can
// resolve a (possibly negative, group) pid back to the mock that owns it.
const pidToProc = new Map<number, MockProcess>();
let nextPid = 10000;

// Records a delivered signal and, if it's a terminating one for this process,
// emits an async "exit". Shared by both the process' own kill() (used by
// sendSignal) and the process.kill() spy (used by group stops).
function deliverSignal(proc: MockProcess, signal: string | undefined) {
  killLog.push({ cmd: proc.spawnArgs?.cmd ?? "", signal });
  if (signal === undefined || proc.exitOnSignals.has(signal)) {
    setTimeout(() => proc.emit("exit", null, signal), 0);
  }
}

function createMockProcess(): MockProcess {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const proc: MockProcess = {
    pid: nextPid++,
    exitOnSignals: new Set(["SIGTERM", "SIGKILL"]),
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
      return proc;
    },
    removeAllListeners(event) {
      if (event) delete listeners[event];
      else for (const key of Object.keys(listeners)) delete listeners[key];
      return proc;
    },
    emit(event, ...args) {
      // Once a process exits, its pid/group is gone: deregister it so later
      // process.kill(-pid) calls find nothing (like a real ESRCH no-op).
      if (event === "exit") pidToProc.delete(proc.pid);
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    stdout: makeStream(),
    stderr: makeStream(),
    kill(signal) {
      deliverSignal(proc, signal);
      return true;
    },
  };
  pidToProc.set(proc.pid, proc);
  return proc;
}

// Output the mocked `ps` (used by the escaped-children reap) should report.
// Tests set this to a "pid ppid\n…" string; default empty = no descendants.
let psOutput = "";

const spawnMock = mock(
  (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const proc = createMockProcess();
    proc.spawnArgs = { cmd, args, opts };
    spawnedProcesses.push(proc);

    if (cmd === "ps") {
      // Simulate `ps`: emit the configured tree, then close.
      setTimeout(() => {
        if (psOutput) proc.stdout.emit(Buffer.from(psOutput));
        proc.emit("close", 0);
      }, 0);
    } else {
      // Simulate a successful async spawn.
      setTimeout(() => proc.emit("spawn"), 0);
    }
    return proc;
  },
);

mock.module("child_process", () => ({ spawn: spawnMock }));

// Import after mocking so the manager picks up the mocked spawn.
import {
  ServiceManager,
  parsePsOutput,
  collectDescendants,
  stripAnsi,
  positiveOr,
  nonEmptyStringOr,
} from "./service-manager";
import { Logger } from "./logger";
import type { UserServiceConfig } from "./types";

// --- Helpers ----------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 5));

interface CapturedLog {
  type: "info" | "error" | "warn";
  message: string;
}

function makeManager(
  services: UserServiceConfig[],
  opts: { maxLogLines?: number } = {},
) {
  const logs: CapturedLog[] = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const logger = new Logger((type, message) => logs.push({ type, message }));
  const sm = new ServiceManager(
    logger,
    services,
    opts.maxLogLines ?? 200,
    (m) => broadcasts.push(m as Record<string, unknown>),
    undefined,
  );
  return { sm, logs, broadcasts };
}

function svc(
  id: string,
  extra: Partial<UserServiceConfig> = {},
): UserServiceConfig {
  return { id, name: id.toUpperCase(), command: [id], ...extra };
}

async function startAndRun(sm: ServiceManager, id: string) {
  await sm.startService(id);
  await tick();
}

const warnings = (logs: CapturedLog[]) =>
  logs.filter((l) => l.type === "warn").map((l) => l.message);

// --- Setup / teardown -------------------------------------------------------

let realSetTimeout: typeof setTimeout;
let killSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Collapse long timers (the 5s SIGKILL fallback, the 500ms restart gap, the
  // Start All wait windows) so tests stay fast — but to a value comfortably
  // above the mock's 0ms "spawn"/exit emits, so a service still reaches
  // "running" before its Start All start-timeout would fire.
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) =>
    realSetTimeout(
      fn,
      typeof ms === "number" && ms >= 200 ? 20 : ms,
      ...rest,
    )) as unknown as typeof setTimeout;

  // Intercept process.kill so group-stop signals (negative pids) hit our mock
  // processes instead of real OS process groups.
  killSpy = spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    const proc = pidToProc.get(Math.abs(Number(pid)));
    if (proc) deliverSignal(proc, signal as string | undefined);
    return true;
  }) as typeof process.kill);

  spawnMock.mockClear();
  spawnedProcesses.length = 0;
  killLog.length = 0;
  pidToProc.clear();
  nextPid = 10000;
  psOutput = "";
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  killSpy.mockRestore();
});

afterAll(() => {
  mock.restore();
});

// --- Existing behavior (regression) -----------------------------------------

describe("ServiceManager — core behavior", () => {
  it("initializes services with stopped status", () => {
    const { sm } = makeManager([svc("a")]);
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("transitions starting -> running on startService", async () => {
    const { sm } = makeManager([svc("a")]);
    await sm.startService("a");
    expect(sm.getService("a")?.status).toBe("starting");
    await tick();
    expect(sm.getService("a")?.status).toBe("running");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stopService sends SIGTERM and resolves to stopped", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    await sm.stopService("a");
    expect(killLog.map((k) => k.signal)).toEqual(["SIGTERM"]);
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("spawns detached so the child leads its own process group (POSIX)", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    expect(spawnedProcesses[0].spawnArgs?.opts.detached).toBe(
      process.platform !== "win32",
    );
  });

  it("stop signals the whole process group via a negative pid (POSIX)", async () => {
    if (process.platform === "win32") return; // no process groups on Windows
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    const pid = spawnedProcesses[0].pid;
    await sm.stopService("a");
    expect(
      killSpy.mock.calls.some(([p, sig]) => p === -pid && sig === "SIGTERM"),
    ).toBe(true);
  });

  it("gracefulShutdown signals only the main process, never the group", async () => {
    if (process.platform === "win32") return;
    const { sm } = makeManager([svc("a", { gracefulShutdown: true })]);
    await startAndRun(sm, "a");
    await sm.stopService("a");
    // SIGTERM goes straight to the process so it can coordinate its own
    // children, and (unlike the default path) no group SIGKILL is sent when it
    // exits — those children are the main's responsibility.
    expect(killSpy.mock.calls.some(([pid]) => Number(pid) < 0)).toBe(false);
    expect(killLog.some((k) => k.signal === "SIGTERM")).toBe(true);
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("force-kills the process group once the leader exits (reaps stragglers)", async () => {
    if (process.platform === "win32") return;
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    const pid = spawnedProcesses[0].pid;
    await sm.stopService("a");
    // After the leader's exit, a group SIGKILL is sent so any child that
    // outlived it (e.g. ignored SIGTERM) can't keep holding a port.
    expect(
      killSpy.mock.calls.some(([p, sig]) => p === -pid && sig === "SIGKILL"),
    ).toBe(true);
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("force-kill reaps escaped descendants found via ps", async () => {
    if (process.platform === "win32") return;
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    const pid = spawnedProcesses[0].pid;
    // ps reports pid 99999 as a child of the service that left the group.
    psOutput = `${pid} 1\n99999 ${pid}\n`;
    // Ignore SIGTERM so the force-kill path (and the reap) runs.
    spawnedProcesses[0].exitOnSignals = new Set(["SIGKILL"]);
    await sm.stopService("a");
    expect(
      killSpy.mock.calls.some(([p, sig]) => p === 99999 && sig === "SIGKILL"),
    ).toBe(true);
  });

  it("stopService falls back to SIGKILL after the timeout", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    // Make the process ignore SIGTERM so the SIGKILL fallback fires.
    spawnedProcesses[0].exitOnSignals = new Set(["SIGKILL"]);
    await sm.stopService("a");
    expect(killLog.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("pipes stdout and stderr into the service log", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");

    spawnedProcesses[0].stdout.emit(Buffer.from("hello from stdout\n"));
    spawnedProcesses[0].stderr.emit(Buffer.from("oops from stderr\n"));

    const logs = sm.getService("a")?.logs ?? [];
    expect(
      logs.some(
        (l) => l.logType === "stdout" && l.line.includes("hello from stdout"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) => l.logType === "stderr" && l.line.includes("oops from stderr"),
      ),
    ).toBe(true);
  });

  it("handles a process 'error' event by entering the error state", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");

    spawnedProcesses[0].emit("error", new Error("spawn boom"));

    expect(sm.getService("a")?.status).toBe("error");
    expect(sm.getService("a")?.errorDetails).toContain("spawn boom");
  });

  it("can be started again after crashing", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");

    // Simulate a crash (non-graceful exit via signal).
    spawnedProcesses[0].emit("exit", null, "SIGSEGV");
    expect(sm.getService("a")?.status).toBe("crashed");

    // Recovery: starting a crashed service must be allowed.
    await startAndRun(sm, "a");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("carries a per-service stopTimeout through to the service", () => {
    const { sm } = makeManager([svc("a", { stopTimeout: 8000 })]);
    expect(sm.getService("a")?.stopTimeout).toBe(8000);
  });

  it("restartService stops then starts again", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    await sm.restartService("a");
    await tick();
    expect(killLog.some((k) => k.signal === "SIGTERM")).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("clearServiceLogs truncates logs and broadcasts logs_cleared", () => {
    const { sm, broadcasts } = makeManager([svc("a")]);
    sm.addLog("a", "line one");
    sm.addLog("a", "line two");
    sm.clearServiceLogs("a");
    // The clear itself appends one "Log buffer cleared by user." entry.
    expect(sm.getService("a")?.logs).toHaveLength(1);
    expect(
      broadcasts.some((b) => b.type === "logs_cleared" && b.serviceID === "a"),
    ).toBe(true);
  });

  it("respects the maxLogLines cap", () => {
    const { sm } = makeManager([svc("a")], { maxLogLines: 3 });
    for (let i = 0; i < 5; i++) sm.addLog("a", `line ${i}`);
    expect(sm.getService("a")?.logs).toHaveLength(3);
  });
});

// --- Custom signals ---------------------------------------------------------

describe("ServiceManager — sendSignal", () => {
  // A service that declares SIGHUP in its allow-list.
  const sigHupSvc = (id: string) =>
    svc(id, { signals: [{ label: "Reload", signal: "SIGHUP" }] });

  it("sends a declared signal to a running process", async () => {
    const { sm } = makeManager([sigHupSvc("a")]);
    await startAndRun(sm, "a");
    sm.sendSignal("a", "SIGHUP");
    expect(killLog).toEqual([{ cmd: "a", signal: "SIGHUP" }]);
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("is a no-op when the service is not running", () => {
    const { sm, logs } = makeManager([sigHupSvc("a")]);
    sm.sendSignal("a", "SIGHUP");
    expect(killLog).toHaveLength(0);
    expect(warnings(logs).some((m) => m.includes("Cannot send"))).toBe(true);
  });

  it("refuses a signal the service didn't declare", async () => {
    const { sm, logs } = makeManager([sigHupSvc("a")]);
    await startAndRun(sm, "a");
    // SIGUSR1 is a perfectly valid OS signal, but it isn't in signals[].
    sm.sendSignal("a", "SIGUSR1");
    expect(killLog).toHaveLength(0);
    expect(warnings(logs).some((m) => m.includes("undeclared signal"))).toBe(
      true,
    );
  });

  it("rejects unknown signal strings", async () => {
    // Declared (so it passes the allow-list) but not a real OS signal name.
    const { sm, logs } = makeManager([
      svc("a", { signals: [{ label: "Bogus", signal: "NOT_A_SIGNAL" }] }),
    ]);
    await startAndRun(sm, "a");
    sm.sendSignal("a", "NOT_A_SIGNAL");
    expect(killLog).toHaveLength(0);
    expect(warnings(logs).some((m) => m.includes("unknown signal"))).toBe(true);
  });
});

// --- dependsOn --------------------------------------------------------------

describe("ServiceManager — dependsOn ordering", () => {
  const ids = (sm: ServiceManager) => sm.getServices().map((s) => s.id);

  it("leaves services without dependsOn in config order", () => {
    const { sm } = makeManager([svc("a"), svc("b"), svc("c")]);
    expect(ids(sm)).toEqual(["a", "b", "c"]);
  });

  it("sorts a linear chain a -> b -> c", () => {
    const { sm } = makeManager([
      svc("c", { dependsOn: ["b"] }),
      svc("b", { dependsOn: ["a"] }),
      svc("a"),
    ]);
    expect(ids(sm)).toEqual(["a", "b", "c"]);
  });

  it("sorts a diamond graph", () => {
    const { sm } = makeManager([
      svc("d", { dependsOn: ["b", "c"] }),
      svc("c", { dependsOn: ["a"] }),
      svc("b", { dependsOn: ["a"] }),
      svc("a"),
    ]);
    const order = ids(sm);
    const idx = (id: string) => order.indexOf(id);
    expect(idx("a")).toBeLessThan(idx("b"));
    expect(idx("a")).toBeLessThan(idx("c"));
    expect(idx("b")).toBeLessThan(idx("d"));
    expect(idx("c")).toBeLessThan(idx("d"));
  });

  it("throws on a dependency cycle", () => {
    expect(() =>
      makeManager([
        svc("a", { dependsOn: ["b"] }),
        svc("b", { dependsOn: ["a"] }),
      ]),
    ).toThrow(/cycle/);
  });

  it("throws on a self-dependency", () => {
    expect(() => makeManager([svc("a", { dependsOn: ["a"] })])).toThrow(
      /itself/,
    );
  });

  it("throws on a duplicate service id", () => {
    expect(() => makeManager([svc("a"), svc("a")])).toThrow(/duplicate/);
  });

  it("throws on an empty command", () => {
    expect(() => makeManager([svc("a", { command: [] })])).toThrow(
      /empty or invalid command/,
    );
  });

  it("throws on a command whose first element is an empty string", () => {
    expect(() => makeManager([svc("a", { command: [""] })])).toThrow(
      /empty or invalid command/,
    );
  });

  it("warns and ignores unknown dependsOn IDs", () => {
    const { sm, logs } = makeManager([svc("x", { dependsOn: ["ghost"] })]);
    expect(sm.getService("x")?.dependsOn).toEqual([]);
    expect(warnings(logs).some((m) => m.includes("unknown service"))).toBe(
      true,
    );
  });

  it("stopAllServices stops in reverse start order and broadcasts progress", async () => {
    const { sm, broadcasts } = makeManager([
      svc("c", { dependsOn: ["b"] }),
      svc("b", { dependsOn: ["a"] }),
      svc("a"),
    ]);
    // Start order is a, b, c.
    await startAndRun(sm, "a");
    await startAndRun(sm, "b");
    await startAndRun(sm, "c");
    killLog.length = 0;
    broadcasts.length = 0;
    await sm.stopAllServices();
    expect(killLog.map((k) => k.cmd)).toEqual(["c", "b", "a"]);
    expect(broadcasts.find((b) => b.type === "stop_all_begin")).toMatchObject({
      total: 3,
    });
    expect(broadcasts.find((b) => b.type === "stop_all_done")).toMatchObject({
      stopped: 3,
    });
  });
});

// --- startAllServices orchestration -----------------------------------------

describe("ServiceManager — startAllServices", () => {
  const findDone = (broadcasts: Array<Record<string, unknown>>) =>
    broadcasts.find((b) => b.type === "start_all_done");

  it("starts every service and reports success", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a"),
      svc("b", { dependsOn: ["a"] }),
    ]);
    await sm.startAllServices();
    expect(broadcasts.find((b) => b.type === "start_all_begin")).toMatchObject({
      total: 2,
    });
    expect(findDone(broadcasts)).toMatchObject({
      started: 2,
      failed: 0,
      skipped: 0,
    });
    expect(sm.getService("a")?.status).toBe("running");
    expect(sm.getService("b")?.status).toBe("running");
  });

  it("skips transitive dependents of a failed service", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", {
        beforeStart: async () => {
          throw new Error("boom");
        },
      }),
      svc("b", { dependsOn: ["a"] }),
      svc("c"),
    ]);
    await sm.startAllServices();
    // a failed -> b (depends on a) skipped; c is unrelated and starts.
    expect(findDone(broadcasts)).toMatchObject({
      started: 1,
      failed: 1,
      skipped: 1,
    });
    expect(sm.getService("a")?.status).toBe("error");
    expect(sm.getService("b")?.status).toBe("stopped");
    expect(sm.getService("c")?.status).toBe("running");
  });

  it("ignores a concurrent startAllServices call", async () => {
    const { sm } = makeManager([svc("a")]);
    const first = sm.startAllServices();
    const second = sm.startAllServices(); // should be a no-op while first runs
    await Promise.all([first, second]);
    expect(sm.getService("a")?.status).toBe("running");
  });
});

// --- startAndWait dedup -----------------------------------------------------

describe("ServiceManager — startAndWait dedup", () => {
  it("dedupes concurrent starts so an orphaned timer can't tear down a running service", async () => {
    const { sm } = makeManager([svc("a")]);

    // Two concurrent starts for the same service. Before the dedup fix, the
    // second call overwrote the first's waiter in `startWaiters`, orphaning the
    // first call's start-timeout timer — which then fired against the
    // now-`running` service and wrongly tore it down into `error`.
    const p1 = sm.startAndWait("a");
    const p2 = sm.startAndWait("a");

    // The second start attaches to the in-flight run rather than starting a
    // second one (same promise, so a single waiter + single timer).
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(sm.getService("a")?.status).toBe("running");

    // Wait past the (collapsed) start-timeout window: no orphaned timer should
    // fire and tear the healthy running service down.
    await new Promise((r) => setTimeout(r, 40));
    expect(sm.getService("a")?.status).toBe("running");
    expect(
      spawnedProcesses.filter((p) => p.spawnArgs?.cmd === "a"),
    ).toHaveLength(1);
  });
});

describe("ServiceManager — stopAllServices", () => {
  it("stays silent when there are no running services to stop", async () => {
    // Server shutdown with nothing running should not broadcast a begin/done
    // pair — that rendered a confusing "0 services stopped" toast in the UI.
    const { sm, broadcasts } = makeManager([svc("a"), svc("b")]);
    await sm.stopAllServices();
    expect(broadcasts.find((b) => b.type === "stop_all_begin")).toBeUndefined();
    expect(broadcasts.find((b) => b.type === "stop_all_done")).toBeUndefined();
  });

  it("reports a service as failed (not stopped) when its stop throws", async () => {
    const { sm, broadcasts } = makeManager([svc("a"), svc("b")]);
    await startAndRun(sm, "a");
    await startAndRun(sm, "b");

    // Make stopping "a" throw, leaving "b" to stop normally.
    const original = sm.stopService.bind(sm);
    sm.stopService = (id, opts) =>
      id === "a" ? Promise.reject(new Error("kaboom")) : original(id, opts);

    await sm.stopAllServices();

    const progressA = broadcasts.find(
      (m) => m.type === "stop_all_progress" && m.serviceID === "a",
    );
    expect(progressA?.result).toBe("failed");
    expect(broadcasts.find((m) => m.type === "stop_all_done")).toMatchObject({
      stopped: 1,
      failed: 1,
    });
  });
});

// --- beforeStart hook -------------------------------------------------------

describe("ServiceManager — beforeStart hook", () => {
  it("runs the hook before spawn and passes the returned env", async () => {
    let ranBeforeSpawn = false;
    const { sm } = makeManager([
      svc("a", {
        env: { ORIG: "1" },
        beforeStart: async () => {
          ranBeforeSpawn = spawnMock.mock.calls.length === 0;
          return { env: { CUSTOM: "yes" } };
        },
      }),
    ]);
    await startAndRun(sm, "a");
    expect(ranBeforeSpawn).toBe(true);
    expect(sm.getService("a")?.status).toBe("running");
    const env = spawnedProcesses[0].spawnArgs?.opts.env as Record<
      string,
      string
    >;
    expect(env.CUSTOM).toBe("yes");
  });

  it("applies web links returned by the hook (as liveWebLinks) and broadcasts them", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", {
        webLinks: [{ label: "Original", url: "http://x/1" }],
        beforeStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Added", url: "http://x/2" }],
        }),
      }),
    ]);
    await startAndRun(sm, "a");
    // The configured baseline is untouched; the hook's result is the live set.
    expect(sm.getService("a")?.webLinks).toEqual([
      { label: "Original", url: "http://x/1" },
    ]);
    expect(sm.getService("a")?.liveWebLinks).toEqual([
      { label: "Original", url: "http://x/1" },
      { label: "Added", url: "http://x/2" },
    ]);
    expect(
      broadcasts.some((b) => b.type === "links_update" && b.serviceID === "a"),
    ).toBe(true);
  });

  it("does not accumulate hook-added links across restarts", async () => {
    const { sm } = makeManager([
      svc("a", {
        webLinks: [{ label: "Original", url: "http://x/1" }],
        beforeStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Added", url: "http://x/2" }],
        }),
      }),
    ]);
    await startAndRun(sm, "a");
    await sm.stopService("a");
    await startAndRun(sm, "a");
    // The hook always sees the configured baseline, so a second run yields the
    // same two links — not three.
    expect(sm.getService("a")?.liveWebLinks).toEqual([
      { label: "Original", url: "http://x/1" },
      { label: "Added", url: "http://x/2" },
    ]);
  });

  it("hook logging produces a system log entry", async () => {
    const { sm } = makeManager([
      svc("a", {
        beforeStart: async (ctx) => {
          ctx.log("hook says hello");
        },
      }),
    ]);
    await startAndRun(sm, "a");
    const logs = sm.getService("a")?.logs ?? [];
    expect(
      logs.some((l) => l.logType === "system" && l.line === "hook says hello"),
    ).toBe(true);
  });

  it("a throwing hook leaves the service in error and never spawns", async () => {
    const { sm } = makeManager([
      svc("a", {
        beforeStart: async () => {
          throw new Error("boom");
        },
      }),
    ]);
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.status).toBe("error");
    expect(sm.getService("a")?.errorDetails).toContain("boom");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("stopping during initializing aborts the hook and never spawns", async () => {
    let release!: () => void;
    const hookGate = new Promise<void>((r) => {
      release = r;
    });
    let capturedSignal: AbortSignal | undefined;

    const { sm } = makeManager([
      svc("a", {
        beforeStart: async (ctx) => {
          capturedSignal = ctx.signal;
          await hookGate;
        },
      }),
    ]);

    const startPromise = sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("initializing");

    await sm.stopService("a");
    expect(sm.getService("a")?.status).toBe("stopped");
    expect(capturedSignal?.aborted).toBe(true);

    release();
    await startPromise;

    expect(sm.getService("a")?.status).toBe("stopped");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("times out a hung beforeStart during Start All: errors it and never spawns", async () => {
    const { sm } = makeManager([
      svc("a", { beforeStart: () => new Promise<void>(() => {}) }), // never resolves
      svc("b", { dependsOn: ["a"] }),
    ]);
    await sm.startAllServices();
    await tick();

    expect(sm.getService("a")?.status).toBe("error");
    expect(sm.getService("a")?.errorDetails).toContain("beforeStart");
    expect(spawnMock).not.toHaveBeenCalled();
    // b depends on the timed-out service, so it's skipped (stays stopped).
    expect(sm.getService("b")?.status).toBe("stopped");
  });

  it("a hook returning void keeps the original env", async () => {
    const { sm } = makeManager([
      svc("a", {
        env: { ORIG: "1" },
        beforeStart: async () => {
          // returns void
        },
      }),
    ]);
    await startAndRun(sm, "a");
    const env = spawnedProcesses[0].spawnArgs?.opts.env as Record<
      string,
      string
    >;
    expect(env.ORIG).toBe("1");
  });
});

// --- afterStart hook --------------------------------------------------------

describe("ServiceManager — afterStart hook", () => {
  it("runs after spawn and promotes to running once it resolves", async () => {
    let ranAfterSpawn = false;
    const { sm } = makeManager([
      svc("a", {
        afterStart: async () => {
          ranAfterSpawn = spawnMock.mock.calls.length > 0;
        },
      }),
    ]);
    await startAndRun(sm, "a");
    expect(ranAfterSpawn).toBe(true);
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("sits in finalizing while the hook is pending, then goes running", async () => {
    let release!: () => void;
    const hookGate = new Promise<void>((r) => {
      release = r;
    });
    const { sm } = makeManager([
      svc("a", {
        afterStart: async () => {
          await hookGate;
        },
      }),
    ]);

    const startPromise = sm.startService("a");
    await tick(); // spawn fires, hook starts
    expect(sm.getService("a")?.status).toBe("finalizing");

    release();
    await startPromise;
    await tick();
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("applies web links returned by the hook (as liveWebLinks) and broadcasts them", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", {
        webLinks: [{ label: "Original", url: "http://x/1" }],
        afterStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Ready", url: "http://x/2" }],
        }),
      }),
    ]);
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.liveWebLinks).toEqual([
      { label: "Original", url: "http://x/1" },
      { label: "Ready", url: "http://x/2" },
    ]);
    expect(
      broadcasts.some((b) => b.type === "links_update" && b.serviceID === "a"),
    ).toBe(true);
  });

  it("extends beforeStart's links without accumulating across restarts", async () => {
    const { sm } = makeManager([
      svc("a", {
        webLinks: [{ label: "Base", url: "http://x/0" }],
        beforeStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Pre", url: "http://x/1" }],
        }),
        afterStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Post", url: "http://x/2" }],
        }),
      }),
    ]);
    const expected = [
      { label: "Base", url: "http://x/0" },
      { label: "Pre", url: "http://x/1" },
      { label: "Post", url: "http://x/2" },
    ];

    await startAndRun(sm, "a");
    expect(sm.getService("a")?.liveWebLinks).toEqual(expected);

    // Restart: links rebuild from the baseline, so they don't accumulate.
    await sm.stopService("a");
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.liveWebLinks).toEqual(expected);
  });

  it("reverts links to the configured baseline when the service stops", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", {
        webLinks: [{ label: "Base", url: "http://x/0" }],
        afterStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Live", url: "http://x/1" }],
        }),
      }),
    ]);
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.liveWebLinks).toEqual([
      { label: "Base", url: "http://x/0" },
      { label: "Live", url: "http://x/1" },
    ]);

    await sm.stopService("a");
    await tick();
    // Live links are dropped; the display falls back to the baseline, and the
    // revert is broadcast so the dashboard updates.
    expect(sm.getService("a")?.liveWebLinks).toBeUndefined();
    const revert = broadcasts
      .filter((b) => b.type === "links_update" && b.serviceID === "a")
      .at(-1);
    expect(revert?.webLinks).toEqual([{ label: "Base", url: "http://x/0" }]);
  });

  it("a throwing hook tears the process back down and ends in error", async () => {
    const { sm } = makeManager([
      svc("a", {
        afterStart: async () => {
          throw new Error("migration failed");
        },
      }),
    ]);
    await startAndRun(sm, "a");
    await tick(); // let the teardown SIGTERM/exit settle
    const service = sm.getService("a");
    expect(service?.status).toBe("error");
    expect(service?.errorDetails).toContain("migration failed");
    expect(service?.process).toBeNull();
  });

  it("does not apply afterStart links if the process exited mid-hook", async () => {
    let release!: (v: { webLinks: { label: string; url: string }[] }) => void;
    const gate = new Promise<{ webLinks: { label: string; url: string }[] }>(
      (r) => {
        release = r;
      },
    );
    const { sm } = makeManager([
      svc("a", {
        webLinks: [{ label: "Base", url: "http://x/0" }],
        afterStart: () => gate,
      }),
    ]);

    void sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");

    // The process exits on its own (clean exit) while the hook is still pending.
    const proc = spawnedProcesses.find((p) => p.spawnArgs?.cmd === "a")!;
    proc.emit("exit", 0, null);
    await tick();
    expect(sm.getService("a")?.status).toBe("stopped");

    // Hook now resolves with links — they must NOT be applied to a dead service.
    release({ webLinks: [{ label: "Stale", url: "http://x/1" }] });
    await tick();
    expect(sm.getService("a")?.status).toBe("stopped"); // not promoted to running
    expect(sm.getService("a")?.liveWebLinks).toBeUndefined(); // no stale links
  });

  it("ends in error when afterStart throws after the process already exited", async () => {
    let reject!: (e: Error) => void;
    const gate = new Promise<void>((_resolve, rej) => {
      reject = rej;
    });
    const { sm } = makeManager([svc("a", { afterStart: () => gate })]);

    void sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");

    // Process exits cleanly first (would be "stopped" on its own).
    const proc = spawnedProcesses.find((p) => p.spawnArgs?.cmd === "a")!;
    proc.emit("exit", 0, null);
    await tick();
    expect(sm.getService("a")?.status).toBe("stopped");

    // Hook then throws: the failed hook must win and settle the service on error.
    reject(new Error("migration failed"));
    await tick();
    expect(sm.getService("a")?.status).toBe("error");
    expect(sm.getService("a")?.errorDetails).toContain("migration failed");
  });

  it("aborts the afterStart signal when the process exits mid-hook", async () => {
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { sm } = makeManager([
      svc("a", {
        afterStart: async (ctx) => {
          capturedSignal = ctx.signal;
          await gate; // stand in for a readiness poll
        },
      }),
    ]);

    void sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");
    expect(capturedSignal?.aborted).toBe(false);

    // The process crashes on its own while the hook is mid-poll: the signal
    // must fire so a real readiness check could give up.
    const proc = spawnedProcesses.find((p) => p.spawnArgs?.cmd === "a")!;
    proc.emit("exit", null, "SIGSEGV");
    await tick();
    expect(capturedSignal?.aborted).toBe(true);

    // Hook finishes after noticing; the crash status stands (no promotion).
    release();
    await tick();
    expect(sm.getService("a")?.status).toBe("crashed");
  });

  it("a stale afterStart throwing late does not clobber a restarted service", async () => {
    let throwOld!: (e: Error) => void;
    const firstHook = new Promise<void>((_resolve, reject) => {
      throwOld = reject;
    });
    let firstRun = true;
    const { sm } = makeManager([
      svc("a", {
        afterStart: () => {
          if (firstRun) {
            firstRun = false;
            return firstHook; // run 1: hangs, ignores the abort
          }
          return Promise.resolve(); // run 2: comes up clean
        },
      }),
    ]);

    // Run 1 reaches finalizing, then its process crashes on its own.
    void sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");
    const proc1 = spawnedProcesses.find((p) => p.spawnArgs?.cmd === "a")!;
    proc1.emit("exit", null, "SIGSEGV");
    await tick();
    expect(sm.getService("a")?.status).toBe("crashed");

    // Restart: run 2 spawns and comes up running.
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.status).toBe("running");

    // The stale run-1 hook finally throws — it must not tear down run 2.
    throwOld(new Error("late failure"));
    await tick();
    await tick();
    expect(sm.getService("a")?.status).toBe("running");
    expect(sm.getService("a")?.process).not.toBeNull();
  });

  it("stopping during finalizing aborts the hook and stops the service", async () => {
    let release!: () => void;
    const hookGate = new Promise<void>((r) => {
      release = r;
    });
    let capturedSignal: AbortSignal | undefined;

    const { sm } = makeManager([
      svc("a", {
        afterStart: async (ctx) => {
          capturedSignal = ctx.signal;
          await hookGate;
        },
      }),
    ]);

    const startPromise = sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");

    await sm.stopService("a");
    await tick();
    expect(capturedSignal?.aborted).toBe(true);
    expect(sm.getService("a")?.status).toBe("stopped");

    release();
    await startPromise;
    expect(sm.getService("a")?.status).toBe("stopped");
  });

  it("times out a hung afterStart during Start All: errors it and tears the process down", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", { afterStart: () => new Promise<void>(() => {}) }), // never resolves
      svc("b", { dependsOn: ["a"] }),
    ]);
    // startAllServices awaits the timeout teardown, so by the time it resolves
    // the process is already gone — no extra ticks needed.
    await sm.startAllServices();

    const a = sm.getService("a");
    expect(a?.status).toBe("error");
    expect(a?.errorDetails).toContain("afterStart");
    expect(a?.process).toBeNull();
    // b depends on the timed-out service, so it's skipped (stays stopped).
    expect(sm.getService("b")?.status).toBe("stopped");
    expect(broadcasts.find((x) => x.type === "start_all_done")).toMatchObject({
      failed: 1,
      skipped: 1,
    });
  });

  it("Start All waits for an already in-flight service instead of restarting/killing it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { sm } = makeManager([
      svc("a", {
        afterStart: async () => {
          await gate;
        },
      }),
      svc("b", { dependsOn: ["a"] }),
    ]);

    // Start "a" manually; it spawns and parks in finalizing on the gated hook.
    void sm.startService("a");
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing");
    const spawnsBefore = spawnMock.mock.calls.length;

    // Start All while "a" is mid-hook: it should attach to the existing run
    // (not respawn, not time it out), and wait before starting dependent "b".
    const allPromise = sm.startAllServices();
    await tick();
    expect(sm.getService("a")?.status).toBe("finalizing"); // not error
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore); // not respawned
    expect(sm.getService("b")?.status).toBe("stopped"); // b waits

    release();
    await allPromise;
    expect(sm.getService("a")?.status).toBe("running");
    expect(sm.getService("b")?.status).toBe("running");
  });

  it("times out a hung afterStart on a manual single-service start (startAndWait)", async () => {
    const { sm } = makeManager([
      svc("a", { afterStart: () => new Promise<void>(() => {}) }), // never resolves
    ]);

    // A manual start goes through startAndWait, so the afterStart timeout
    // applies just like during Start All — it must not park in finalizing.
    await sm.startAndWait("a");

    const a = sm.getService("a");
    expect(a?.status).toBe("error");
    expect(a?.errorDetails).toContain("afterStart");
    expect(a?.process).toBeNull();
  });

  it("times out a hung beforeStart on a restart (startAndWait)", async () => {
    let hang = false;
    const { sm } = makeManager([
      svc("a", {
        beforeStart: () =>
          hang ? new Promise<void>(() => {}) : Promise.resolve(),
      }),
    ]);

    // First start comes up clean.
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.status).toBe("running");

    // Restart with a now-hanging beforeStart: the timeout must error it rather
    // than leave it parked in initializing forever.
    hang = true;
    await sm.restartService("a");

    const a = sm.getService("a");
    expect(a?.status).toBe("error");
    expect(a?.errorDetails).toContain("beforeStart");
  });

  it("Start All waits for afterStart before starting a dependent", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const { sm } = makeManager([
      svc("a", {
        afterStart: async () => {
          order.push("a:afterStart-start");
          await aGate;
          order.push("a:afterStart-end");
        },
      }),
      svc("b", {
        dependsOn: ["a"],
        beforeStart: async () => {
          order.push("b:beforeStart");
        },
      }),
    ]);

    const allPromise = sm.startAllServices();
    await tick();
    // a is finalizing; b must not have begun starting yet.
    expect(sm.getService("a")?.status).toBe("finalizing");
    expect(order).toEqual(["a:afterStart-start"]);

    releaseA();
    await allPromise;
    expect(order).toEqual([
      "a:afterStart-start",
      "a:afterStart-end",
      "b:beforeStart",
    ]);
    expect(sm.getService("a")?.status).toBe("running");
    expect(sm.getService("b")?.status).toBe("running");
  });
});

// --- Process-tree helpers (PPID walk) ---------------------------------------

describe("parsePsOutput", () => {
  it("parses `ps -o pid=,ppid=` output into a parent→children map", () => {
    const map = parsePsOutput(
      [
        "  100   1",
        "  200 100",
        "  300 100",
        "  400 200",
        "garbage line",
        "",
      ].join("\n"),
    );
    expect(map.get(1)).toEqual([100]);
    expect(map.get(100)).toEqual([200, 300]);
    expect(map.get(200)).toEqual([400]);
    expect(map.get(999)).toBeUndefined();
  });
});

describe("collectDescendants", () => {
  const map = new Map<number, number[]>([
    [100, [200, 300]],
    [200, [400]],
    [300, [500]],
    [400, [600]],
  ]);

  it("collects the full descendant tree breadth-first", () => {
    expect(collectDescendants(100, map).sort((a, b) => a - b)).toEqual([
      200, 300, 400, 500, 600,
    ]);
  });

  it("returns an empty list for a leaf pid", () => {
    expect(collectDescendants(600, map)).toEqual([]);
  });

  it("does not loop forever on a malformed cyclic map", () => {
    const cyclic = new Map<number, number[]>([
      [1, [2]],
      [2, [1]],
    ]);
    expect(collectDescendants(1, cyclic).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("stripAnsi", () => {
  const ESC = "\x1b";
  const BEL = "\x07";

  it("strips SGR color/style codes while keeping the text", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[1;32mbold green${ESC}[0m`)).toBe("bold green");
    // 256-color / truecolor params (semicolon-separated) are SGR too.
    expect(stripAnsi(`${ESC}[38;5;208morange${ESC}[39m`)).toBe("orange");
  });

  it("strips cursor-move and erase (clear-line / clear-screen) codes", () => {
    // Carriage-return progress-spinner pattern: move to col, erase line.
    expect(stripAnsi(`\r${ESC}[2K${ESC}[1G50%`)).toBe("\r50%");
    expect(stripAnsi(`${ESC}[2J${ESC}[Hcleared`)).toBe("cleared");
    expect(stripAnsi(`up${ESC}[3Aover`)).toBe("upover");
  });

  it("strips OSC sequences (e.g. window-title sets)", () => {
    expect(stripAnsi(`${ESC}]0;my title${BEL}done`)).toBe("done");
    // OSC terminated by ST (ESC \) instead of BEL.
    expect(stripAnsi(`${ESC}]2;title${ESC}\\after`)).toBe("after");
  });

  it("leaves text that merely looks like a code untouched", () => {
    expect(stripAnsi("arr[0m] and [1;32m")).toBe("arr[0m] and [1;32m");
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
    expect(stripAnsi("")).toBe("");
  });

  it("strips multiple sequences in one line", () => {
    expect(stripAnsi(`${ESC}[31ma${ESC}[0m${ESC}[2Kb${ESC}[1Gc`)).toBe("abc");
  });
});

describe("positiveOr", () => {
  it("keeps a finite positive number", () => {
    expect(positiveOr(5000, 1234)).toBe(5000);
    expect(positiveOr(1, 200)).toBe(1);
    expect(positiveOr(0.5, 200)).toBe(0.5);
  });

  it("treats 0, negatives, and undefined as unset", () => {
    expect(positiveOr(0, 200)).toBe(200);
    expect(positiveOr(-1, 200)).toBe(200);
    expect(positiveOr(-9999, 5000)).toBe(5000);
    expect(positiveOr(undefined, 200)).toBe(200);
  });

  it("treats non-finite values as unset", () => {
    expect(positiveOr(NaN, 200)).toBe(200);
    expect(positiveOr(Infinity, 200)).toBe(200);
    expect(positiveOr(-Infinity, 200)).toBe(200);
  });
});

describe("nonEmptyStringOr", () => {
  it("keeps a non-empty string, trimmed", () => {
    expect(nonEmptyStringOr("0.0.0.0", "localhost")).toBe("0.0.0.0");
    expect(nonEmptyStringOr("  localhost  ", "fallback")).toBe("localhost");
  });

  it("falls back on empty, whitespace-only, or undefined", () => {
    expect(nonEmptyStringOr("", "localhost")).toBe("localhost");
    expect(nonEmptyStringOr("   ", "localhost")).toBe("localhost");
    expect(nonEmptyStringOr(undefined, "localhost")).toBe("localhost");
  });

  it("falls back on non-string values", () => {
    expect(nonEmptyStringOr(123, "localhost")).toBe("localhost");
    expect(nonEmptyStringOr(null, "localhost")).toBe("localhost");
    expect(nonEmptyStringOr({}, "localhost")).toBe("localhost");
  });
});
