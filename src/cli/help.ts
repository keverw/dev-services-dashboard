import { EXIT_DESCRIPTIONS } from "./exit-codes";

export interface CommandSpec {
  name: string;
  aliases: string[];
  args: string;
  summary: string;
  flags: { name: string; summary: string }[];
}

/**
 * The command table, used both to render `--help` and to answer
 * `dsd help --json`. One definition drives both so the machine-readable
 * manifest can't drift from the text a human reads.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: "status",
    aliases: ["list", "ls", "ps"],
    args: "[service]",
    summary: "Show every service and its status, or one service in detail.",
    flags: [
      {
        name: "--check",
        summary:
          "Exit 3 unless the named service (or every service) is running. Makes `dsd status api --check || dsd start api` a one-liner.",
      },
    ],
  },
  {
    name: "start",
    aliases: [],
    args: "<service>",
    summary:
      "Start a service and wait for the outcome. Exits 3 if it fails to come up.",
    flags: [
      {
        name: "--no-wait",
        summary: "Return as soon as the start is triggered, without waiting.",
      },
    ],
  },
  {
    name: "stop",
    aliases: [],
    args: "<service>",
    summary: "Stop a service and wait for it to terminate.",
    flags: [
      {
        name: "--force",
        summary:
          "SIGKILL immediately instead of SIGTERM plus the stopTimeout grace period. Works on a service already wedged in `stopping`, where it cuts the wait short.",
      },
      {
        name: "--grace <ms>",
        summary:
          "Override the SIGTERM grace period for this request, instead of the service's configured stopTimeout. Useful in a fast edit/restart loop.",
      },
    ],
  },
  {
    name: "restart",
    aliases: [],
    args: "<service>",
    summary:
      "Restart a service and wait for it to come back up. Exits 3 if it doesn't.",
    flags: [
      {
        name: "--no-wait",
        summary: "Return as soon as the restart is triggered.",
      },
      {
        name: "--force",
        summary:
          "SIGKILL the old process immediately rather than waiting out its grace period.",
      },
      {
        name: "--grace <ms>",
        summary:
          "Override the SIGTERM grace period for this request, instead of the service's configured stopTimeout. Useful in a fast edit/restart loop.",
      },
    ],
  },
  {
    name: "start-all",
    aliases: [],
    args: "",
    summary: "Start every service in dependency order. Exits 3 if any failed.",
    flags: [],
  },
  {
    name: "stop-all",
    aliases: [],
    args: "",
    summary:
      "Stop every service in reverse dependency order. Exits 3 if any failed.",
    flags: [
      {
        name: "--force",
        summary:
          "SIGKILL every service, including any already stuck in `stopping` from an earlier stop-all.",
      },
      {
        name: "--grace <ms>",
        summary:
          "Override the SIGTERM grace period for this request, instead of the service's configured stopTimeout. Useful in a fast edit/restart loop.",
      },
    ],
  },
  {
    name: "logs",
    aliases: [],
    args: "<service>",
    summary:
      "Print buffered log lines for a service (newest last), or stream them with --follow.",
    flags: [
      {
        name: "-f, --follow",
        summary:
          "Stream new lines as they arrive (Ctrl+C to stop). Replays the last 10 lines first, or -n of them. Under --json this emits NDJSON, one entry per line.",
      },
      {
        name: "-n, --lines <n>",
        summary: "How many lines to show (default 100, or 10 with --follow).",
      },
      {
        name: "--type <types>",
        summary: "Comma-separated filter: stdout, stderr, system.",
      },
      {
        name: "--since <ms>",
        summary: "Only entries newer than this epoch-milliseconds timestamp.",
      },
      {
        name: "--cursor <seq>",
        summary:
          "Only entries after this sequence number, for polling: pass back the nextCursor from the previous --json response. Prefer this over --since, whose millisecond timestamps can be shared by several entries. Pages forward from the cursor, so --lines is a page size here, not a tail.",
      },
      {
        name: "--plain",
        summary: "Print bare log lines with no timestamp prefix.",
      },
    ],
  },
  {
    name: "clear-logs",
    aliases: [],
    args: "<service>",
    summary: "Clear a service's log buffer.",
    flags: [],
  },
  {
    name: "signal",
    aliases: ["kill"],
    args: "<service> <SIGNAL>",
    summary:
      "Send a signal the service declares in its `signals` config. Exits 7 if it isn't allowed.",
    flags: [],
  },
  {
    name: "health",
    aliases: ["ping"],
    args: "",
    summary:
      "Check that a dashboard is reachable. Exits 5 if not, 6 if it's shutting down.",
    flags: [],
  },
  {
    name: "help",
    aliases: [],
    args: "[command]",
    summary: "Show this help, or help for one command.",
    flags: [
      { name: "--json", summary: "Emit the full command manifest as JSON." },
    ],
  },
  {
    name: "version",
    aliases: [],
    args: "",
    summary: "Print the CLI version.",
    flags: [],
  },
];

const GLOBAL_FLAGS = [
  {
    name: "--url <url>",
    summary: "Dashboard URL (default http://localhost:4000).",
  },
  { name: "--json", summary: "Machine-readable JSON on stdout." },
  { name: "--no-color", summary: "Disable ANSI color." },
  {
    name: "--timeout <ms>",
    summary:
      "Client timeout. Defaults to none for start/stop/restart/start-all/stop-all, 15000 elsewhere.",
  },
  { name: "-h, --help", summary: "Show help." },
  { name: "-v, --version", summary: "Show version." },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

/** Long-form option names in a flag list, e.g. `-n, --lines <n>` to `lines`. */
function optionNames(flags: { name: string }[]): Set<string> {
  const names = new Set<string>();
  for (const flag of flags) {
    for (const [, name] of flag.name.matchAll(/--([a-z][\w-]*)/g)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The options accepted everywhere, and the extra ones a single command accepts,
 * as `parseArgs` names them (no leading dashes).
 *
 * Derived from the same tables that render `--help`, so a flag can't be added
 * to a command's documentation and still be rejected at the door, or the other
 * way round.
 */
export const GLOBAL_OPTIONS = optionNames(GLOBAL_FLAGS);

export function commandOptions(spec: CommandSpec): Set<string> {
  return optionNames(spec.flags);
}

/**
 * How many positional arguments a command takes, read off its `args` line:
 * `<service>` is required, `[service]` is optional.
 */
export function commandArity(spec: CommandSpec): { min: number; max: number } {
  const parts = spec.args.split(/\s+/).filter(Boolean);
  return {
    min: parts.filter((p) => p.startsWith("<")).length,
    max: parts.length,
  };
}

/** The JSON manifest behind `dsd help --json`. */
export function helpManifest(version: string) {
  return {
    ok: true as const,
    name: "dev-services-dashboard",
    version,
    defaultURL: DEFAULT_URL,
    urlEnvVars: ["DEV_SERVICES_DASHBOARD_URL", "DSD_URL"],
    globalFlags: GLOBAL_FLAGS,
    commands: COMMANDS,
    exitCodes: Object.fromEntries(EXIT_DESCRIPTIONS),
  };
}

export const DEFAULT_URL = "http://localhost:4000";

function renderFlags(flags: { name: string; summary: string }[]): string[] {
  if (flags.length === 0) return [];
  const width = Math.max(...flags.map((f) => f.name.length));
  return flags.map((f) => `  ${f.name.padEnd(width)}  ${f.summary}`);
}

export function commandHelp(spec: CommandSpec): string {
  const lines = [
    `dsd ${spec.name}${spec.args ? ` ${spec.args}` : ""}`,
    "",
    `  ${spec.summary}`,
  ];

  if (spec.aliases.length > 0) {
    lines.push("", `Aliases: ${spec.aliases.join(", ")}`);
  }
  if (spec.flags.length > 0) {
    lines.push("", "Options:", ...renderFlags(spec.flags));
  }

  lines.push("", "Global options:", ...renderFlags(GLOBAL_FLAGS));
  return lines.join("\n");
}

export function rootHelp(version: string): string {
  const width = Math.max(
    ...COMMANDS.map((c) => `${c.name} ${c.args}`.trim().length),
  );

  const commandLines = COMMANDS.map(
    (c) => `  ${`${c.name} ${c.args}`.trim().padEnd(width)}  ${c.summary}`,
  );

  const exitLines = EXIT_DESCRIPTIONS.map(
    ([code, description]) => `${code} ${description}`,
  );

  return [
    `dev-services-dashboard CLI v${version} (dsd)`,
    "",
    "Controls a Dev Services Dashboard that is ALREADY RUNNING. It does not start",
    "the dashboard itself. Boot that however you normally do, then point this at it.",
    "",
    "Usage: dsd <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Global options:",
    ...renderFlags(GLOBAL_FLAGS),
    "",
    "AGENT NOTES",
    "  Add --json to any command for machine-readable output on stdout.",
    "  Under --json, errors are JSON on stderr and stdout stays clean for piping.",
    `  Exit codes: ${exitLines.join(" · ")}`,
    "  Discover the whole surface as JSON:  dsd help --json",
    "  Every command maps to an HTTP route, so plain curl works too:",
    "    curl localhost:4000/api/v1/services",
    "  No authentication: it trusts anything that can reach the port, same as the web UI.",
    "",
    `Dashboard URL: --url, then $DEV_SERVICES_DASHBOARD_URL, then $DSD_URL, else ${DEFAULT_URL}`,
  ].join("\n");
}
