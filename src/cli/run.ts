import { parseArgs } from "node:util";
import type { LogEntry } from "@shared/protocol";
import type {
  ClearLogsResponse,
  HealthResponse,
  LogsResponse,
  ServiceListResponse,
  ServiceResponse,
  SignalResponse,
  StartAllResponse,
  StopAllResponse,
} from "@shared/control-api";
import { ApiClient, exitCodeForApiError, type ApiResult } from "./client";
import { EXIT, type ExitCode } from "./exit-codes";
import {
  entryLines,
  formatLogEntries,
  formatServiceDetail,
  formatServiceTable,
  noColor,
  shouldColor,
  withColor,
  type Colorize,
} from "./format";
import {
  COMMANDS,
  DEFAULT_URL,
  commandHelp,
  findCommand,
  helpManifest,
  rootHelp,
} from "./help";
import { followLogs } from "./follow";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  version: string;
  /**
   * Stops a long-running command (today, `logs --follow`). `bin.ts` wires this
   * to SIGINT; tests use it to end a follow deterministically.
   */
  signal?: AbortSignal;
}

/** Commands whose server side can legitimately block for a long time. */
const SLOW_COMMANDS = new Set(["start", "restart", "start-all", "stop-all"]);
const DEFAULT_TIMEOUT_MS = 15_000;
/** Buffered lines replayed before `logs --follow` switches to live output. */
const DEFAULT_FOLLOW_LINES = 10;

/**
 * The whole CLI, as a function.
 *
 * `bin.ts` is only a shebang plus `process.exit(await run(...))`. Keeping the
 * logic here — with output and environment injected — means the tests can drive
 * real commands against a real dashboard and assert on exit codes and captured
 * stdout, without spawning a child process.
 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    // A parseArgs rejection (unknown flag, missing value) is a usage error;
    // anything else is a genuine internal fault.
    const message = err instanceof Error ? err.message : String(err);
    const isUsage =
      typeof (err as { code?: string }).code === "string" &&
      (err as { code: string }).code.startsWith("ERR_PARSE_ARGS");

    io.stderr(`dsd: ${message}\n`);
    return isUsage ? EXIT.USAGE : EXIT.INTERNAL;
  }
}

async function dispatch(argv: string[], io: CliIO): Promise<number> {
  // The whole argv is parsed in one pass with a single option spec, so flags
  // work on either side of the command — `dsd --url X status` and
  // `dsd status --url X` are both natural to type and both valid.
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string" },
      json: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      timeout: { type: "string" },
      check: { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n" },
      type: { type: "string" },
      since: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  // No command at all: `dsd`, `dsd --help`, `dsd --version`.
  if (positionals.length === 0) {
    if (values.version) io.stdout(`${io.version}\n`);
    else io.stdout(`${rootHelp(io.version)}\n`);
    return EXIT.OK;
  }

  const commandName = positionals[0];
  const spec = findCommand(commandName);
  if (!spec) {
    io.stderr(
      `dsd: unknown command "${commandName}".\nRun "dsd help" to see the available commands.\n`,
    );
    return EXIT.USAGE;
  }

  if (values.help) {
    io.stdout(`${commandHelp(spec)}\n`);
    return EXIT.OK;
  }

  const json = values.json === true;
  const color: Colorize = shouldColor(
    io.isTTY,
    io.env,
    values["no-color"] === true,
  )
    ? withColor
    : noColor;

  // Local commands that never touch the network.
  if (spec.name === "version") {
    io.stdout(
      json
        ? `${JSON.stringify({ ok: true, version: io.version })}\n`
        : `${io.version}\n`,
    );
    return EXIT.OK;
  }

  if (spec.name === "help") {
    if (json) {
      io.stdout(`${JSON.stringify(helpManifest(io.version), null, 2)}\n`);
      return EXIT.OK;
    }
    // positionals[0] is "help" itself; the command being asked about follows it.
    const topic = positionals[1];
    const target = topic ? findCommand(topic) : undefined;
    if (topic && !target) {
      io.stderr(`dsd: unknown command "${topic}".\n`);
      return EXIT.USAGE;
    }
    io.stdout(`${target ? commandHelp(target) : rootHelp(io.version)}\n`);
    return EXIT.OK;
  }

  const timeoutMs = resolveTimeout(values.timeout, spec.name);
  if (timeoutMs === null) {
    io.stderr("dsd: --timeout must be a non-negative integer.\n");
    return EXIT.USAGE;
  }

  const baseURL = resolveURL(values.url, io.env);
  const client = new ApiClient({ baseURL, timeoutMs });

  // Drop the command itself, so a handler's `positionals[0]` is its first real
  // argument (a service id for most commands).
  const ctx: Ctx = {
    io,
    json,
    color,
    client,
    baseURL,
    positionals: positionals.slice(1),
    values,
  };

  switch (spec.name) {
    case "status":
      return commandStatus(ctx);
    case "start":
      return commandLifecycle(ctx, "start");
    case "stop":
      return commandLifecycle(ctx, "stop");
    case "restart":
      return commandLifecycle(ctx, "restart");
    case "start-all":
      return commandStartAll(ctx);
    case "stop-all":
      return commandStopAll(ctx);
    case "logs":
      return commandLogs(ctx);
    case "clear-logs":
      return commandClearLogs(ctx);
    case "signal":
      return commandSignal(ctx);
    case "health":
      return commandHealth(ctx);
    default:
      io.stderr(`dsd: command "${spec.name}" is not implemented.\n`);
      return EXIT.INTERNAL;
  }
}

interface Ctx {
  io: CliIO;
  json: boolean;
  color: Colorize;
  client: ApiClient;
  /** The resolved dashboard URL; `logs --follow` derives its ws:// URL from it. */
  baseURL: string;
  positionals: string[];
  values: Record<string, unknown>;
}

/**
 * Resolves the dashboard URL. An explicit flag wins, then either env var, then
 * the default the library itself uses.
 */
function resolveURL(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const raw =
    flag ?? env.DEV_SERVICES_DASHBOARD_URL ?? env.DSD_URL ?? DEFAULT_URL;
  // Tolerate a bare host:port and a trailing slash — both are natural to type.
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** Returns the timeout in ms, or null if the flag was malformed. */
function resolveTimeout(
  flag: string | undefined,
  commandName: string,
): number | null {
  if (flag !== undefined) {
    const value = Number(flag);
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }

  // No client-side deadline for the slow commands: a start can legitimately run
  // for beforeStartTimeout + startTimeout + afterStartTimeout (~130s by
  // default), and timing out early would report a failure that didn't happen.
  return SLOW_COMMANDS.has(commandName) ? 0 : DEFAULT_TIMEOUT_MS;
}

function requireService(ctx: Ctx): string | undefined {
  const id = ctx.positionals[0];
  if (!id) {
    ctx.io.stderr("dsd: a service id is required.\n");
    return undefined;
  }
  return id;
}

/**
 * Renders a failed `ApiResult` and returns its exit code. Under `--json` the
 * error goes to stderr as a parseable object so stdout stays clean for piping.
 */
function reportFailure(ctx: Ctx, result: ApiResult<unknown>): ExitCode {
  let code: ExitCode;
  let message: string;
  let errorCode: string;

  switch (result.kind) {
    case "api":
      code = exitCodeForApiError(result.error.code);
      message = result.error.message;
      errorCode = result.error.code;
      break;
    case "unreachable":
      code = EXIT.UNREACHABLE;
      message = result.message;
      errorCode = "unreachable";
      break;
    case "unexpected":
      code = EXIT.UNEXPECTED;
      message = result.message;
      errorCode = "unexpected_response";
      break;
    case "ok":
      return EXIT.OK;
  }

  if (ctx.json) {
    ctx.io.stderr(
      `${JSON.stringify({
        ok: false,
        error: { code: errorCode, message },
        exitCode: code,
      })}\n`,
    );
  } else {
    ctx.io.stderr(`dsd: ${message}\n`);
  }

  return code;
}

function emitJSON(ctx: Ctx, data: unknown) {
  ctx.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

async function commandStatus(ctx: Ctx): Promise<number> {
  const id = ctx.positionals[0];
  const check = ctx.values.check === true;

  if (id) {
    const result = await ctx.client.get<ServiceResponse>(
      `/services/${encodeURIComponent(id)}`,
    );
    if (result.kind !== "ok") return reportFailure(ctx, result);

    if (ctx.json) emitJSON(ctx, result.data);
    else
      ctx.io.stdout(`${formatServiceDetail(result.data.service, ctx.color)}\n`);

    return check && result.data.service.status !== "running"
      ? EXIT.FAILED
      : EXIT.OK;
  }

  const result = await ctx.client.get<ServiceListResponse>("/services");
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) emitJSON(ctx, result.data);
  else
    ctx.io.stdout(`${formatServiceTable(result.data.services, ctx.color)}\n`);

  return check && result.data.services.some((s) => s.status !== "running")
    ? EXIT.FAILED
    : EXIT.OK;
}

async function commandLifecycle(
  ctx: Ctx,
  action: "start" | "stop" | "restart",
): Promise<number> {
  const id = requireService(ctx);
  if (!id) return EXIT.USAGE;

  const body =
    action === "stop" ? {} : { wait: ctx.values["no-wait"] !== true };

  const result = await ctx.client.post<ServiceResponse>(
    `/services/${encodeURIComponent(id)}/${action}`,
    body,
  );
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) emitJSON(ctx, result.data);
  else
    ctx.io.stdout(
      `${result.data.service.name} is now ${ctx.color(result.data.service.status, "cyan")}.\n`,
    );

  return EXIT.OK;
}

async function commandStartAll(ctx: Ctx): Promise<number> {
  const result = await ctx.client.post<StartAllResponse>("/start-all");
  if (result.kind !== "ok") return reportFailure(ctx, result);

  const { started, failed, skipped, total } = result.data;
  if (ctx.json) emitJSON(ctx, result.data);
  else
    ctx.io.stdout(
      `Started ${started}/${total} services (${failed} failed, ${skipped} skipped).\n`,
    );

  return failed > 0 ? EXIT.FAILED : EXIT.OK;
}

async function commandStopAll(ctx: Ctx): Promise<number> {
  const result = await ctx.client.post<StopAllResponse>("/stop-all");
  if (result.kind !== "ok") return reportFailure(ctx, result);

  const { stopped, failed, total } = result.data;
  if (ctx.json) emitJSON(ctx, result.data);
  else
    ctx.io.stdout(`Stopped ${stopped}/${total} services (${failed} failed).\n`);

  return failed > 0 ? EXIT.FAILED : EXIT.OK;
}

/** Parses `--type stdout,stderr` into a set; an empty set means "all". */
function parseLogTypes(raw: unknown): Set<LogEntry["logType"]> | null {
  const types = new Set<LogEntry["logType"]>();
  if (raw === undefined) return types;

  for (const part of String(raw).split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (value !== "stdout" && value !== "stderr" && value !== "system") {
      return null;
    }
    types.add(value);
  }
  return types;
}

async function commandLogs(ctx: Ctx): Promise<number> {
  const id = requireService(ctx);
  if (!id) return EXIT.USAGE;

  const lines =
    ctx.values.lines === undefined ? undefined : Number(ctx.values.lines);
  if (lines !== undefined && (!Number.isInteger(lines) || lines < 0)) {
    ctx.io.stderr("dsd: --lines must be a non-negative integer.\n");
    return EXIT.USAGE;
  }

  if (ctx.values.follow === true) {
    const logTypes = parseLogTypes(ctx.values.type);
    if (logTypes === null) {
      ctx.io.stderr(
        "dsd: --type accepts a comma-separated list of stdout, stderr, system.\n",
      );
      return EXIT.USAGE;
    }

    // `--since` is a buffer query; following starts from the buffered tail and
    // then streams live, so the two don't combine meaningfully.
    if (ctx.values.since !== undefined) {
      ctx.io.stderr("dsd: --since cannot be combined with --follow.\n");
      return EXIT.USAGE;
    }

    return followLogs({
      baseURL: ctx.baseURL,
      serviceID: id,
      initialLines: lines ?? DEFAULT_FOLLOW_LINES,
      logTypes,
      json: ctx.json,
      plain: ctx.values.plain === true,
      color: ctx.color,
      stdout: ctx.io.stdout,
      stderr: ctx.io.stderr,
      signal: ctx.io.signal,
    });
  }

  const params = new URLSearchParams();
  if (lines !== undefined) {
    params.set("limit", String(lines));
  }
  if (ctx.values.type !== undefined)
    params.set("logType", String(ctx.values.type));
  if (ctx.values.since !== undefined)
    params.set("since", String(ctx.values.since));

  const query = params.toString();
  const path = `/services/${encodeURIComponent(id)}/logs${query ? `?${query}` : ""}`;

  const result = await ctx.client.get<LogsResponse>(path);
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) {
    emitJSON(ctx, result.data);
    return EXIT.OK;
  }

  const { entries } = result.data;
  if (entries.length === 0) {
    // To stderr, so `dsd logs api | wc -l` stays honest about there being no lines.
    ctx.io.stderr("dsd: no matching log lines.\n");
    return EXIT.OK;
  }

  ctx.io.stdout(
    ctx.values.plain === true
      ? `${entries.flatMap(entryLines).join("\n")}\n`
      : `${formatLogEntries(entries, ctx.color)}\n`,
  );
  return EXIT.OK;
}

async function commandClearLogs(ctx: Ctx): Promise<number> {
  const id = requireService(ctx);
  if (!id) return EXIT.USAGE;

  const result = await ctx.client.delete<ClearLogsResponse>(
    `/services/${encodeURIComponent(id)}/logs`,
  );
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) emitJSON(ctx, result.data);
  else ctx.io.stdout(`Cleared logs for ${id}.\n`);
  return EXIT.OK;
}

async function commandSignal(ctx: Ctx): Promise<number> {
  const id = requireService(ctx);
  if (!id) return EXIT.USAGE;

  const signal = ctx.positionals[1];
  if (!signal) {
    ctx.io.stderr(
      "dsd: a signal name is required, e.g. `dsd signal api SIGHUP`.\n",
    );
    return EXIT.USAGE;
  }

  const result = await ctx.client.post<SignalResponse>(
    `/services/${encodeURIComponent(id)}/signal`,
    { signal },
  );
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) emitJSON(ctx, result.data);
  else ctx.io.stdout(`Sent ${signal} to ${id}.\n`);
  return EXIT.OK;
}

async function commandHealth(ctx: Ctx): Promise<number> {
  const result = await ctx.client.get<HealthResponse>("/health");
  if (result.kind !== "ok") return reportFailure(ctx, result);

  if (ctx.json) emitJSON(ctx, result.data);
  else
    ctx.io.stdout(
      `${result.data.dashboardName}: ${result.data.serviceCount} services, up ${Math.round(
        result.data.uptimeMs / 1000,
      )}s.\n`,
    );

  // A dashboard that is mid-teardown is reachable but not usable; say so with a
  // distinct code rather than a cheerful 0.
  return result.data.shuttingDown ? EXIT.SHUTTING_DOWN : EXIT.OK;
}

/** Exported for the help text tests. */
export { COMMANDS };
