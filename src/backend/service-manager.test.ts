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
  // Collapse long timers (the 5s SIGKILL fallback, the 500ms restart gap) so
  // tests stay fast and deterministic.
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) =>
    realSetTimeout(
      fn,
      typeof ms === "number" && ms >= 200 ? 1 : ms,
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
  it("sends the signal to a running process", async () => {
    const { sm } = makeManager([svc("a")]);
    await startAndRun(sm, "a");
    sm.sendSignal("a", "SIGHUP");
    expect(killLog).toEqual([{ cmd: "a", signal: "SIGHUP" }]);
    expect(sm.getService("a")?.status).toBe("running");
  });

  it("is a no-op when the service is not running", () => {
    const { sm, logs } = makeManager([svc("a")]);
    sm.sendSignal("a", "SIGHUP");
    expect(killLog).toHaveLength(0);
    expect(warnings(logs).some((m) => m.includes("Cannot send"))).toBe(true);
  });

  it("rejects unknown signal strings", async () => {
    const { sm, logs } = makeManager([svc("a")]);
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

  it("warns and ignores unknown dependsOn IDs", () => {
    const { sm, logs } = makeManager([svc("x", { dependsOn: ["ghost"] })]);
    expect(sm.getService("x")?.dependsOn).toEqual([]);
    expect(warnings(logs).some((m) => m.includes("unknown service"))).toBe(
      true,
    );
  });

  it("stopAllServices stops in reverse start order", async () => {
    const { sm } = makeManager([
      svc("c", { dependsOn: ["b"] }),
      svc("b", { dependsOn: ["a"] }),
      svc("a"),
    ]);
    // Start order is a, b, c.
    await startAndRun(sm, "a");
    await startAndRun(sm, "b");
    await startAndRun(sm, "c");
    killLog.length = 0;
    await sm.stopAllServices();
    expect(killLog.map((k) => k.cmd)).toEqual(["c", "b", "a"]);
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

  it("applies web links returned by the hook and broadcasts them", async () => {
    const { sm, broadcasts } = makeManager([
      svc("a", {
        webLinks: [{ label: "Original", url: "http://x/1" }],
        beforeStart: async ({ webLinks }) => ({
          webLinks: [...webLinks, { label: "Added", url: "http://x/2" }],
        }),
      }),
    ]);
    await startAndRun(sm, "a");
    expect(sm.getService("a")?.webLinks).toEqual([
      { label: "Original", url: "http://x/1" },
      { label: "Added", url: "http://x/2" },
    ]);
    expect(
      broadcasts.some((b) => b.type === "links_update" && b.serviceID === "a"),
    ).toBe(true);
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
