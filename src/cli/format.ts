import type { LogEntry, ServiceStatusValue } from "@shared/protocol";
import type { ServiceSummary } from "@shared/control-api";

/**
 * ANSI codes written out rather than pulled from a package — the dashboard ships
 * with two runtime dependencies and adding a color library for eight escape
 * codes isn't a trade worth making.
 */
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

export type Colorize = (text: string, code: keyof typeof ANSI) => string;

/** A no-op colorizer, used when output isn't a TTY or color is disabled. */
export const noColor: Colorize = (text) => text;

export const withColor: Colorize = (text, code) =>
  `${ANSI[code]}${text}${ANSI.reset}`;

/**
 * Whether to emit color. Unlike the output *format* (which never changes
 * implicitly — see `run.ts`), color genuinely should follow the stream: nobody
 * wants escape codes in a piped file, and `NO_COLOR` is a broadly honored
 * convention.
 */
export function shouldColor(
  isTTY: boolean,
  env: Record<string, string | undefined>,
  noColorFlag: boolean,
): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTTY;
}

function statusColor(status: ServiceStatusValue): keyof typeof ANSI {
  switch (status) {
    case "running":
      return "green";
    case "error":
    case "crashed":
      return "red";
    case "initializing":
    case "starting":
    case "finalizing":
    case "stopping":
      return "yellow";
    case "stopped":
      return "dim";
  }
}

/** Renders rows as a left-aligned, space-padded table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const render = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i]),
      )
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}

export function formatServiceTable(
  services: ServiceSummary[],
  color: Colorize,
): string {
  if (services.length === 0) return "No services configured.";

  const rows = services.map((s) => [
    s.id,
    color(s.status, statusColor(s.status)),
    s.pid === null ? "-" : String(s.pid),
    String(s.logCount),
    s.errorDetails ?? "",
  ]);

  return table(["SERVICE", "STATUS", "PID", "LOGS", "ERROR"], rows);
}

export function formatServiceDetail(
  service: ServiceSummary,
  color: Colorize,
): string {
  const lines = [
    `${color("id", "dim")}        ${service.id}`,
    `${color("name", "dim")}      ${service.name}`,
    `${color("status", "dim")}    ${color(service.status, statusColor(service.status))}`,
    `${color("pid", "dim")}       ${service.pid ?? "-"}`,
    `${color("logs", "dim")}      ${service.logCount}`,
  ];

  if (service.errorDetails) {
    lines.push(
      `${color("error", "dim")}     ${color(service.errorDetails, "red")}`,
    );
  }
  if (service.dependsOn.length > 0) {
    lines.push(`${color("dependsOn", "dim")} ${service.dependsOn.join(", ")}`);
  }
  if (service.signals.length > 0) {
    lines.push(
      `${color("signals", "dim")}   ${service.signals.map((s) => s.signal).join(", ")}`,
    );
  }
  for (const link of service.webLinks) {
    lines.push(
      `${color("link", "dim")}      ${link.label}: ${color(link.url, "cyan")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Splits a buffered entry into display lines.
 *
 * A log entry is one chunk of process output, not one line: it carries its
 * trailing newline and may contain several embedded ones. Rendering it verbatim
 * double-spaces the output, so strip the trailing break and expand the rest.
 */
export function entryLines(entry: LogEntry): string[] {
  return entry.line.replace(/\r?\n$/, "").split("\n");
}

export function formatLogEntries(entries: LogEntry[], color: Colorize): string {
  return entries
    .flatMap((entry) => {
      const time = color(new Date(entry.timestamp).toISOString(), "dim");
      const tag =
        entry.logType === "stderr"
          ? color("stderr", "red")
          : entry.logType === "system"
            ? color("system", "cyan")
            : color("stdout", "dim");
      // Prefix every line of a multi-line chunk, so each printed line stands on
      // its own and stays greppable.
      return entryLines(entry).map((line) => `${time} ${tag} ${line}`);
    })
    .join("\n");
}
