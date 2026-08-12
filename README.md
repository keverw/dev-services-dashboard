# Dev Services Dashboard v1.1.0

[![npm version](https://badge.fury.io/js/dev-services-dashboard.svg)](https://badge.fury.io/js/dev-services-dashboard)

![](icon-thumbnail.png)

A lightweight development UI dashboard for managing and monitoring multiple services during local development.

[![Dev Services Dashboard showing multiple services](screenshot.png)](screenshot.png)

<!-- toc -->

- [Overview](#overview)
- [Features](#features)
- [Usage](#usage)
  - [Quick Setup](#quick-setup)
  - [Configuration Options](#configuration-options)
    - [Storing Config in Separate Files](#storing-config-in-separate-files)
    - [Return Value](#return-value)
    - [Shutting Down](#shutting-down)
  - [Service Configuration](#service-configuration)
    - [Web Links](#web-links)
    - [Custom Signals](#custom-signals)
    - [Startup Ordering With dependsOn](#startup-ordering-with-dependson)
    - [Pre-Start Hook (beforeStart)](#pre-start-hook-beforestart)
    - [Post-Start Hook (afterStart)](#post-start-hook-afterstart)
    - [Process Termination](#process-termination)
  - [Logger Configuration](#logger-configuration)
    - [No Logging by Default](#no-logging-by-default)
    - [Using the Console Logger](#using-the-console-logger)
    - [Creating a Custom Logger](#creating-a-custom-logger)
    - [Disabling Logging](#disabling-logging)
- [Example](#example)
- [CLI & Control API](#cli--control-api)
  - [How it fits together](#how-it-fits-together)
  - [Connecting](#connecting)
  - [Commands](#commands)
  - [Stopping a stuck service](#stopping-a-stuck-service)
  - [Going faster in a restart loop](#going-faster-in-a-restart-loop)
  - [Following logs](#following-logs)
  - [Exit codes](#exit-codes)
  - [HTTP control API](#http-control-api)
  - [Security](#security)
  - [Using with AI agents](#using-with-ai-agents)
- [Demo](#demo)
- [Development](#development)
  - [Project Structure](#project-structure)
  - [backend](#backend)
  - [frontend-react](#frontend-react)
  - [frontend-build](#frontend-build)
  - [Technical Details](#technical-details)
- [Future Goals](#future-goals)

<!-- tocstop -->

## Overview

Dev Services Dashboard provides a web-based dashboard to:

- Start, stop, and restart development services
- Monitor service logs in real-time
- Track service status (running, stopped, error, etc.)
- Manage multiple services from a single interface
- Define and spin up your entire local development stack (databases, APIs, web servers, etc.)

Perfect for local development where you need to run multiple interdependent services that would typically be separate managed services in production (databases, caches, message queues, microservices, etc.).

## Features

- **Real-time Logs**: View service logs as they happen. ANSI escape sequences (CSI and OSC), color/style as well as cursor moves and clear-line/clear-screen "spam" are stripped, since logs are rendered as plain text
- **Log Management**: Clear a service's log buffer from the UI ("Clear Logs"). This clears it on the server and for all connected clients (a single `Log buffer cleared by user.` system line is then written in its place)
- **Service Controls**: Start, stop, restart services individually or all at once ("Start All" / "Stop All"). A stop that's dragging on can be escalated: the Stop button becomes "Force Stop" while one is in flight, and "Stop All" likewise becomes "Force Stop All", skipping the grace period and killing the process group outright
- **Status Monitoring**: Visual indicators for service status
- **Startup Ordering**: Declare `dependsOn` so services start in dependency order (and stop in reverse)
- **Custom Signals**: Send declared POSIX signals (`SIGHUP`, `SIGUSR1`, …) to a running service from the UI
- **Pre-start Hooks**: Run an async `beforeStart` hook to prepare env/state before a service spawns
- **Post-start Hooks**: Run an async `afterStart` hook as a readiness gate after spawn (wait for a port, run a migration). Throwing fails the startup
- **Web Links**: Quick access buttons to related URLs (docs, admin panels, health checks, etc.)
- **Connection Status**: Clear indication of connection state with automatic reconnection
- **Responsive Design**: Works on desktop and mobile devices
- **CLI & HTTP Control API**: Do everything the UI can from a terminal (`dsd status`, `dsd logs api --lines 50`, `dsd restart api`) with JSON output and meaningful exit codes, so scripts and AI coding agents can drive your dev stack without a browser. See [CLI & Control API](#cli--control-api)

## Usage

### Quick Setup

1. **Install the package:**

   ```bash
   bun add dev-services-dashboard
   # or
   npm add dev-services-dashboard
   # or
   yarn add dev-services-dashboard
   ```

2. **Create a dev runner script** (e.g., `scripts/dev-ui-runner.ts`):

   ```typescript
   import {
     createConsoleLogger,
     startDevServicesDashboard,
     type UserServiceConfig,
   } from "dev-services-dashboard";

   const services: UserServiceConfig[] = [
     {
       id: "db",
       name: "Database (Postgres)",
       command: ["bun", "run", "scripts/dev-db.ts"],
     },
     {
       id: "api",
       name: "API Server",
       command: ["bun", "run", "src/apps/api-server/index.ts"],
       env: { NODE_ENV: "development" },
       webLinks: [
         { label: "API Docs", url: "http://localhost:3001/docs" },
         { label: "Health Check", url: "http://localhost:3001/health" },
       ],
     },
   ];

   const dashboard = await startDevServicesDashboard({
     dashboardName: "My Project Dashboard",
     port: 4000,
     hostname: "localhost",
     maxLogLines: 200,
     defaultCwd: process.cwd(),
     services,
     logger: createConsoleLogger(),
   });

   console.log("Dev Services Dashboard Started!");

   // The library installs no signal handlers, so wire up your own shutdown.
   // (See "Shutting Down" below for the full pattern, including double-Ctrl+C.)
   process.on("SIGINT", async () => {
     await dashboard.stop(); // stop all services, then close the server
     process.exit(0);
   });
   ```

3. **Add a script to your `package.json`:**

   ```json
   {
     "scripts": {
       "dev:dashboard": "bun run scripts/dev-ui-runner.ts"
     }
   }
   ```

4. **Run your dashboard:**

   ```bash
   bun run dev:dashboard
   ```

   **Note**: This Quick Setup example uses Bun, but you can also use Node.js with ts-node or regular JavaScript:

```bash
# With ts-node (for TypeScript)
  npx ts-node scripts/dev-ui-runner.ts

 # Or with regular Node.js (rename to .js and remove types)
 node scripts/dev-ui-runner.js
```

5. **Open your browser** to `http://localhost:4000` to access the dashboard (or on your custom defined port)

### Configuration Options

The `startDevServicesDashboard` function accepts a configuration object with the following properties:

| Option               | Type                               | Default                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`               | number                             | 4000                     | The port to run the Dev Services Dashboard server on. `0` and other non-positive values fall back to `4000` (so `port: 0` does **not** request an OS-assigned ephemeral port)                                                                                                                                                                                                                                                                                                                                                                  |
| `hostname`           | string                             | 'localhost'              | The hostname to bind the server to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `maxLogLines`        | number                             | 200                      | Maximum number of log entries to keep in memory per service. An entry is one output chunk from the process (a chunk can contain multiple newlines, so the rendered line count in the UI may exceed this value) **or** one system message the dashboard writes to the stream (hook output, start/stop notices, exit reasons, refused-signal notices). System messages share the same budget, so they also count toward the cap and can evict older process output                                                                               |
| `defaultCwd`         | string                             | process.cwd()            | Default working directory for services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dashboardName`      | string                             | 'Dev Services Dashboard' | Custom name for the dashboard displayed in the UI and page title                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stopTimeout`        | number                             | 5000                     | Default ms to wait after SIGTERM before escalating to SIGKILL on stop (per-service `stopTimeout` overrides)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `startTimeout`       | number                             | 10000                    | The **spawn window only**: ms a start waits for the process to come up, reaching `running` or entering `finalizing` if the service has an `afterStart` hook, before failing it (tears the process down, marks it `error`). The `beforeStart`/`afterStart` phases are bounded **separately** by `beforeStartTimeout` / `afterStartTimeout`, so a service with hooks can take up to their sum to reach `running`, not `startTimeout` alone. Applies to any start, whether manual, restart, or "Start All" (which then also skips its dependents) |
| `beforeStartTimeout` | number                             | 60000                    | Ms a start waits during a service's `beforeStart` (`initializing`) phase before failing it (aborts the hook, marks it `error`). Applies to any start, whether manual, restart, or "Start All" (which then also skips its dependents)                                                                                                                                                                                                                                                                                                           |
| `afterStartTimeout`  | number                             | 60000                    | Ms a start waits during a service's `afterStart` (`finalizing`) phase before failing it (aborts the hook, tears the process down, marks it `error`). Applies to any start, whether manual, restart, or "Start All" (which then also skips its dependents)                                                                                                                                                                                                                                                                                      |
| `services`           | UserServiceConfig[]                | required                 | Array of service configurations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `logger`             | DevServicesDashboardLoggerFunction | none (no logging)        | Custom logger function for Dev Services Dashboard internal logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Note**: All numeric options treat any non-positive or non-finite value (`0`, a negative number, or `NaN`) as "unset" and fall back to their defaults: `port` (`4000`), `maxLogLines` (`200`), `stopTimeout` (`5000`), `startTimeout` (`10000`), and `beforeStartTimeout` / `afterStartTimeout` (`60000`), including the per-service `stopTimeout`. So there's no way to disable the log buffer with `maxLogLines: 0` (use a small positive number instead) or to force an immediate `SIGKILL` with `stopTimeout: 0`, and a stray negative value can't empty the buffer or collapse a timeout to `0ms`. Likewise, an empty, whitespace-only, or non-string `hostname` or `dashboardName` falls back to its default (`localhost` and `Dev Services Dashboard` respectively), and a valid one is trimmed of surrounding whitespace.

> **⚠️ Binding & network exposure**: `hostname` defaults to `localhost` (the loopback interface, `127.0.0.1`/`::1`), which only accepts connections from your own machine, so other devices on the network can't reach it. Set it to `0.0.0.0` (bind **all** interfaces) or a specific interface IP to make the dashboard reachable from other devices on your LAN, but the dashboard has **no authentication** (not on the web UI, not on the WebSocket, and not on the [HTTP control API](#cli--control-api)) and can start, stop, and signal arbitrary processes on the host, so only expose it on a network you trust. (Note: `0.0.0.0` is the _most_ exposed binding, not the most private. It's the opposite of `localhost`.)

#### Storing Config in Separate Files

You don't have to build the config inline at the call site. Both config types are exported, so you can keep your services (and the whole dashboard config) in their own files and import them. This keeps your runner script tiny and gives you type-checking on the config wherever it lives.

For example, you might keep the dashboard files together in a subfolder like `scripts/dev-services-dashboard/`. Type just the services array with `UserServiceConfig[]`:

```typescript
// scripts/dev-services-dashboard/services.ts
import type { UserServiceConfig } from "dev-services-dashboard";

export const services: UserServiceConfig[] = [
  { id: "db", name: "Database", command: ["bun", "run", "scripts/dev-db.ts"] },
  {
    id: "api",
    name: "API Server",
    command: ["bun", "run", "src/apps/api-server/index.ts"],
    dependsOn: ["db"],
  },
];
```

Or type the entire config object with `DevUIConfig` (this also type-checks the top-level options, so a misspelled option like `beforeStartTimeout` is caught):

```typescript
// scripts/dev-services-dashboard/config.ts
import type { DevUIConfig } from "dev-services-dashboard";
import { services } from "./services";

export const dashboardConfig: DevUIConfig = {
  dashboardName: "My Project",
  port: 4000,
  services,
};
```

Then the runner just imports and starts it:

```typescript
// scripts/dev-ui-runner.ts
import { startDevServicesDashboard } from "dev-services-dashboard";
import { dashboardConfig } from "./dev-services-dashboard/config";

const dashboard = await startDevServicesDashboard(dashboardConfig);
// ... wire up your own shutdown (see "Shutting Down" below).
```

The hook context/return types (`BeforeStartContext`, `BeforeStartResult`, `AfterStartContext`, `AfterStartResult`) are exported too, so a `beforeStart`/`afterStart` hook can also be written in its own file and typed against its context.

#### Return Value

`startDevServicesDashboard` is **async**. It returns a `Promise<DevUIServer>` that resolves once the HTTP server is listening, and rejects if it fails to bind (e.g. the port is in use). Always `await` it (or `.catch()` it), since otherwise a bind failure surfaces as an unhandled promise rejection. You'll want the resolved server anyway, both for clean shutdown via `stop()` and to wire up your own signal handling (see below):

```typescript
const dashboard = await startDevServicesDashboard({ services });
// ... later, to shut down gracefully (stops all services, then closes the server):
await dashboard.stop();
```

The resolved `DevUIServer` object exposes:

| Property     | Type                | Description                                                                                                               |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `httpServer` | http.Server         | The underlying Node HTTP server                                                                                           |
| `wsServer`   | WebSocketServer     | The underlying `ws` WebSocket server                                                                                      |
| `port`       | number              | The port the server is listening on (the normalized config `port`, a non-positive value falls back to the default `4000`) |
| `stop`       | () => Promise<void> | Stops all running services, then closes the HTTP and WebSocket server                                                     |

The dashboard's own UI talks to the server over `wsServer`, but it's the raw `ws` server, so you can attach your own listeners too. If you want to read the frames the server broadcasts (or send your own), the wire protocol types are exported: `ServerMessage` and `ClientMessage` (the discriminated unions for each direction), plus `InitialStateService`, `LogEntry`, `ServiceStatusValue`, and `StartAllResult` / `StopAllResult` (the per-service `result` values in the Start All / Stop All progress frames).

A service is always in exactly one `ServiceStatusValue` state:

| Status         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopped`      | Not running: the initial state, the result of a stop, a clean exit (code `0`), or termination by `SIGTERM`/`SIGINT`. When the exit came from an _external_ `SIGTERM`/`SIGINT` (not a dashboard stop), `errorDetails` carries the reason (e.g. `Terminated by SIGTERM`) even though the state is `stopped`                                                                                                                                                                                                                                      |
| `initializing` | Running its `beforeStart` hook before the process has spawned (bounded by `beforeStartTimeout`)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `starting`     | The process is being spawned, between the spawn and reaching `running`/`finalizing` (bounded by `startTimeout`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `finalizing`   | The process is up and running its `afterStart` readiness hook, not yet reported ready (bounded by `afterStartTimeout`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `running`      | Up and ready, with hooks (if any) completed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `stopping`     | A stop is in progress: `SIGTERM` has been sent and the dashboard is waiting for the process to exit (or to escalate to SIGKILL)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `error`        | A start failed because a hook threw or timed out, the process failed to spawn at all (e.g. the executable wasn't found, isn't executable, or `cwd` doesn't exist), or the process exited non-zero with a "normal" code (any code `1`–`127`). Also the fallback for an exit that reports neither a code nor a signal (an unexpected exit)                                                                                                                                                                                                       |
| `crashed`      | The process died abnormally because it was killed by a signal other than `SIGTERM`/`SIGINT` (a crash signal like `SIGSEGV`, or a custom signal the process didn't handle, see [Custom Signals](#custom-signals)), exited with a code ≥ `128`, or was force-killed (`SIGKILL`) from _outside_ the dashboard while running. (A dashboard-initiated stop that escalates to `SIGKILL` settles as `stopped`, and a start that times out and is torn down settles as `error`, so you only see `crashed` from a `SIGKILL` the dashboard didn't send.) |

#### Shutting Down

The dashboard does **not** install any `SIGINT`/`SIGTERM` handlers or call `process.exit()` on its own. As a library it leaves process lifecycle to you, so a bare `Ctrl+C` will exit your script **without** stopping the running services (leaving them holding their ports). To shut down cleanly, keep the resolved server and call `stop()` (which stops all services, then closes the server) from your own signal handler:

```typescript
const dashboard = await startDevServicesDashboard({ services });

let isShuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  // A second Ctrl+C while the graceful stop is still running forces an exit.
  if (isShuttingDown) process.exit(1);
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down…`);
  try {
    await dashboard.stop(); // stop all services, then close the server
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

`stop()` is best-effort and resolves rather than rejecting: a service that fails to stop is logged via your `logger` (not thrown), and server-close errors are swallowed. It terminates any live WebSocket clients and then awaits the WebSocket and HTTP servers closing, so a resolved `stop()` normally means they've drained, but each close is bounded by a short internal deadline, so a runtime that doesn't fire its close callback (e.g. Bun after a WebSocket upgrade) can't hang shutdown. The `try/catch` above is therefore just defensive hygiene. Keep it if you might add other shutdown steps, or drop it.

### Service Configuration

Each service is defined with the following properties:

| Property           | Type                                                            | Required | Description                                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string                                                          | Yes      | Unique identifier for the service                                                                                                                                                                                                                                                                                           |
| `name`             | string                                                          | Yes      | Display name for the service                                                                                                                                                                                                                                                                                                |
| `command`          | string[]                                                        | Yes      | Command to run (first element is the executable, rest are arguments)                                                                                                                                                                                                                                                        |
| `cwd`              | string                                                          | No       | Working directory for the command. An empty string is treated as unset and falls back to `defaultCwd` (then `process.cwd()`). A non-empty but invalid path is **not** normalized and surfaces as a spawn error (the service goes to `error`)                                                                                |
| `env`              | Record<string, string>                                          | No       | Environment variables to set for the process                                                                                                                                                                                                                                                                                |
| `webLinks`         | WebLink[]                                                       | No       | Array of web links to display as buttons in the service UI                                                                                                                                                                                                                                                                  |
| `signals`          | ServiceSignal[]                                                 | No       | Custom signals you can send to the running process from the UI ([Custom Signals](#custom-signals))                                                                                                                                                                                                                          |
| `dependsOn`        | string[]                                                        | No       | IDs of services this one depends on. Affects Start All / Stop All ordering ([Startup Ordering](#startup-ordering-with-dependson))                                                                                                                                                                                           |
| `beforeStart`      | (ctx: BeforeStartContext) => Promise<BeforeStartResult \| void> | No       | Async hook run before the process spawns. May return `{ env?, webLinks? }` ([Pre-Start Hook](#pre-start-hook-beforestart))                                                                                                                                                                                                  |
| `afterStart`       | (ctx: AfterStartContext) => Promise<AfterStartResult \| void>   | No       | Async readiness gate run after spawn, before `running`. Throwing fails the startup. May return `{ webLinks? }` ([Post-Start Hook](#post-start-hook-afterstart))                                                                                                                                                             |
| `gracefulShutdown` | boolean                                                         | No       | Send the stop `SIGTERM` to only the main process (so it can shut down its own children) instead of the whole group. Forced `SIGKILL` still targets the group. Default `false`. No effect on Windows, which has no process groups and always signals just the launched process ([Process Termination](#process-termination)) |
| `stopTimeout`      | number                                                          | No       | Ms to wait after SIGTERM before escalating to SIGKILL for this service. Overrides the global `stopTimeout`. When unset it **inherits** the global value (which is `5000` unless you change it)                                                                                                                              |

> **Note:** Service config is validated up front. A duplicate `id` or an empty/invalid `command` (the first element must be a non-empty executable string) is a fatal configuration error, so `startDevServicesDashboard` rejects rather than starting with an unusable service (the same way a `dependsOn` cycle or self-dependency does). Only the first element (the executable) is checked, the remaining arguments are passed to the process as-is, so a non-string argument (only reachable from plain JavaScript, since the types require `string[]`) surfaces as a lower-level spawn error instead of an upfront config error.

> **Note:** `command` is run **directly, not through a shell**. The first element is the executable and the rest are passed as literal arguments, so shell features won't work: `&&`/`;` chaining, `|` pipes, `>` redirects, glob expansion, and `$VAR` substitution are all treated as plain text. (Variables you set via `env` are passed to the process, but `$VAR` written _inside_ `command` is not expanded.) If you need shell semantics, invoke a shell explicitly, e.g. `command: ["sh", "-c", "foo && bar"]`.

#### Web Links

Web links appear as clickable buttons in each service's control panel. Each web link is defined with:

| Property | Type   | Required | Description                            |
| -------- | ------ | -------- | -------------------------------------- |
| `label`  | string | Yes      | Display text for the link button       |
| `url`    | string | Yes      | URL to open when the button is clicked |

**Note**: The URLs in the examples below are for demonstration purposes. Make sure the URLs you configure actually correspond to running services or endpoints that your services expose.

#### Custom Signals

Services can declare custom POSIX signals you can send to the running process from the dashboard, which is handy for reloading config (`SIGHUP`), rotating logs, or triggering app-specific behavior (`SIGUSR1` / `SIGUSR2`). A **"Send signal…"** dropdown is shown in the service's control bar whenever it declares any `signals`, but it's only enabled while the service is `running` and connected. It is disabled when the service isn't running or the dashboard has lost its connection to the server.

Each signal is defined with:

| Property | Type   | Required | Description                               |
| -------- | ------ | -------- | ----------------------------------------- |
| `label`  | string | Yes      | Display text shown in the signal dropdown |
| `signal` | string | Yes      | Signal name to send (e.g. `SIGHUP`)       |

Signals are validated on the backend twice: the name must be one this service **declared** in its `signals[]` (the allow-list, so a raw WebSocket client can't send a valid-but-undeclared signal the config never opted into), and it must be a real signal name (checked against `os.constants.signals`). A signal that fails either check is ignored (and logged) rather than sent.

> **Note:** signals require the service to be fully `running`, not merely to have a live process. A service still in its `afterStart` (`finalizing`) phase has spawned but isn't `running` yet, so a signal is refused (the UI dropdown is likewise disabled until `running`).

> **Note:** unlike stop (which signals the whole process group), a custom signal is sent only to the **launched command's main process** by design, so e.g. a `SIGHUP` "reload config" reaches the process you configured rather than every child it forked. The consequence: if your `command` is a wrapper that doesn't forward signals (`bun run …`, `vite`, `nodemon`, a shell script), the signal hits the wrapper, not the underlying dev server. To signal the inner process, run it directly or have the wrapper forward signals.

> **Note:** a signal only does something useful if the process **handles** it. Many of the signals you'd send here (`SIGHUP`, `SIGUSR1`, `SIGUSR2`, `SIGQUIT`, …) have a default action of **terminate**, so sending one to a process that hasn't installed a handler for it will kill that process. The dashboard then reports the service as `crashed` (any signal other than `SIGTERM`/`SIGINT` settles as `crashed`). So a "reload config" `SIGHUP` reloads only if your process traps `SIGHUP`; otherwise it stops the service.

```typescript
{
  id: "api",
  name: "API Server",
  command: ["bun", "run", "src/apps/api-server/index.ts"],
  signals: [
    { label: "Reload config", signal: "SIGHUP" },
    { label: "Reopen logs", signal: "SIGUSR2" },
  ],
}
```

#### Startup Ordering With dependsOn

Services can declare dependencies with `dependsOn` (an array of service `id`s). The dashboard topologically sorts services once at startup so dependencies start before the services that rely on them.

- **Start All** starts services **sequentially** in dependency order, one service at a time, waiting for each to reach `running` before starting the next. (This is true even for services with no dependency relationship: there is no parallel startup, so a large stack starts up in series.) Because it waits for each service to be `running` before moving on, a dependent naturally starts only after its dependency is up. If a service fails, only the services that depend on it (directly or indirectly) are skipped. Unrelated services later in the order keep starting, and a summary toast reports how many were skipped.
- **Stop All** stops services sequentially in **reverse** order, so dependents shut down before the dependencies they rely on.
- Starting a **single** service manually whose dependencies aren't running shows a non-blocking warning but still starts it. `dependsOn` is an orchestration hint, not enforced runtime wiring.
- An unknown dependency `id` is ignored with a warning. A **self-dependency** or a dependency **cycle** is a fatal configuration error, and the dashboard refuses to start (the error message includes the cycle path).

> **Note:** Single-service controls stay enabled during a **Start All** run, so you keep full manual control, but there's one interaction worth knowing. Start All advances by waiting for each service to reach `running`, and it treats any transition to `stopped`, `error`, or `crashed` as a failed start. So if you **stop** or **restart** (which stops first) the service Start All is currently waiting on, Start All counts it as **failed** and skips its dependents, even though a restart then brings the service back up. For a clean Start All run, wait for it to finish before stopping or restarting individual services.

```typescript
const services: UserServiceConfig[] = [
  { id: "db", name: "Database", command: ["bun", "run", "scripts/dev-db.ts"] },
  {
    id: "api",
    name: "API Server",
    command: ["bun", "run", "src/apps/api-server/index.ts"],
    dependsOn: ["db"], // waits for db before starting during Start All
  },
  {
    id: "worker",
    name: "Background Worker",
    command: ["bun", "run", "src/apps/worker/index.ts"],
    dependsOn: ["db", "api"],
  },
];
```

#### Pre-Start Hook (beforeStart)

Each service can define an async `beforeStart` hook that runs **before** the process spawns, useful for waiting on a dependency's port, running a migration, or resolving secrets. While the hook runs, the service shows an `initializing` status and is given the longer `beforeStartTimeout` (default 60000ms) rather than the spawn `startTimeout`. If it exceeds that, the hook is aborted and the service goes to `error`. (This timeout applies to every start: a manual single-service start, a restart, and "Start All".)

The hook receives a `BeforeStartContext`:

> **Note:** the hook context and return types, `BeforeStartContext`, `BeforeStartResult`, `AfterStartContext`, and `AfterStartResult`. These are all exported from the package (alongside `UserServiceConfig`), so you can type a hook written separately from the config literal, e.g. `const prepare = (ctx: BeforeStartContext) => { … }`.

| Property   | Type                   | Description                                                        |
| ---------- | ---------------------- | ------------------------------------------------------------------ |
| `env`      | Record<string, string> | The merged env (process env + service `env`) bound for the process |
| `webLinks` | WebLink[]              | The service's currently configured web links                       |
| `log`      | (line: string) => void | Writes a line to the service's log stream                          |
| `signal`   | AbortSignal            | Aborts if the service is stopped while the hook is still running   |

The hook may return an object to customize the launch (any field left out keeps its current value):

| Field      | Type                   | Effect                                                                                                     |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `env`      | Record<string, string> | Replaces the env passed to the spawned process                                                             |
| `webLinks` | WebLink[]              | Replaces the service's web links, pushed live to the dashboard (omit to leave unchanged, `[]` clears them) |

Return nothing to leave both unchanged. If the hook throws, the service is put into the `error` state, and the dashboard keeps running. If the user stops the service mid-hook, `signal` is aborted and the service returns to `stopped` (the process is never spawned). Any `webLinks` you return apply only while the service is up: they revert to the configured baseline when it stops, crashes, or errors, and are rebuilt on the next start.

> **Note:** `beforeStart` runs _before_ the process spawns, so any `webLinks` you return must be computable up front (e.g. derived from a resolved port/region). Links only known _after_ the process starts (a tunnel URL, a randomly-assigned port printed to stdout) are out of scope for this hook.

**Common uses:**

- **Wait for a dependency**: block until a database/cache port is accepting connections (or a migration finishes) before the service spawns.
- **Inject short-lived / scoped credentials**: rather than baking secrets into config, resolve them per-launch and return them in the env. For example: fetch a fresh token from a local Vault/KMS/enclave emulator (`vault server -dev`), point a service at LocalStack instead of real S3, or mint a restricted sandbox API key so a dev process can't accidentally hit production with full credentials. The `log()` callback lets you surface progress ("Fetching dev credentials…") and `signal` lets you bail cleanly if the user stops the service mid-fetch.
- **Resolve web links at launch**: return `webLinks` to swap in URLs computed from the resolved config (e.g. the port/region this run will use).

```typescript
{
  id: "api",
  name: "API Server",
  command: ["bun", "run", "src/apps/api-server/index.ts"],
  beforeStart: async ({ env, webLinks, log, signal }) => {
    log("Waiting for the database to accept connections...");

    await waitForPort(5432, { signal });

    log("Database is ready.");
    return {
      env: { ...env, DB_READY: "true" }, // augment the env for the process
      webLinks: [...webLinks, { label: "Health", url: "http://localhost:3001/health" }],
    };
  },
}
```

#### Post-Start Hook (afterStart)

Each service can define an async `afterStart` hook that runs **after** the process has spawned but **before** the service is reported `running`, so it acts as a readiness/post-start gate. While it runs, the service shows a `finalizing` status, and "Start All" waits for it to resolve before starting anything that depends on the service. This is the counterpart to `beforeStart`: use it for work that only makes sense once the process is alive, like polling its port until it actually accepts connections, running a migration against the now-running database, or registering the service somewhere.

The hook receives an `AfterStartContext`:

| Property   | Type                   | Description                                                                                                                                                                                                 |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`      | Record<string, string> | The env the process was spawned with                                                                                                                                                                        |
| `pid`      | number \| undefined    | The spawned process's pid                                                                                                                                                                                   |
| `webLinks` | WebLink[]              | The current live web links (what a `beforeStart` returned this run, or the configured baseline)                                                                                                             |
| `log`      | (line: string) => void | Writes a line to the service's log stream                                                                                                                                                                   |
| `signal`   | AbortSignal            | Aborts if the service is stopped while the hook runs, **or** if the process exits/crashes on its own under it, so a readiness check polling the process (`await waitForPort(port, { signal })`) can give up |

The hook may return `{ webLinks? }` to replace the service's web links (pushed live to the dashboard), handy when a link is only knowable _after_ the process is up (a tunnel URL, a port printed to stdout). Return nothing to leave them unchanged (and `[]` clears them). The context's `webLinks` is the current live set (including anything a `beforeStart` added this run), so returning `[...webLinks, x]` extends them, while returning a fresh array discards them. Links are rebuilt from the configured baseline on every (re)start (so this stays idempotent), and revert to the baseline when the service stops, crashes, or errors. A dynamically-computed link (a tunnel URL, a chosen port) doesn't linger on a dead service.

If the hook **throws**, the just-started process is torn back down (it's already live and may be holding ports) and the service ends in the `error` state, so a failed migration/readiness check acts like a failed startup, and "Start All" skips the service's dependents. If the user stops the service mid-hook, `signal` is aborted, the process is terminated, and the service goes to `stopped`. `signal` is **also** aborted if the spawned process exits or crashes on its own while the hook is still running, so a readiness check polling that process can give up rather than hang. The service then settles on whatever state the exit produced, and a hook that throws in response to the abort is still treated as a failed start (`error`). A hook that runs longer than `afterStartTimeout` (default 60000ms) is treated the same as a failure: it's aborted, the process is torn down, and the service goes to `error`. (This timeout applies to every start: a manual single-service start, a restart, and "Start All".)

> **`beforeStart` vs `afterStart`:** `beforeStart` runs _before_ the process exists (prepare env, resolve secrets, gate on a dependency). `afterStart` runs _after_ it's spawned (verify it's actually ready, run a post-launch step). Throwing from either fails the startup.

```typescript
{
  id: "db",
  name: "Database (PostgreSQL)",
  command: ["postgres", "-D", "./pgdata"],
  afterStart: async ({ log, signal }) => {
    log("Waiting for the database to accept connections...");
    await waitForPort(5432, { signal }); // throws if it never comes up

    log("Running migrations...");
    await runMigrations(); // throws on failure -> service ends in `error`

    log("Database ready.");
  },
}
```

#### Process Termination

Stopping a service sends `SIGTERM`, then escalates to `SIGKILL` if it hasn't exited within the stop timeout (default 5000ms, configurable globally via `stopTimeout` or per service via `stopTimeout`). You can also skip the grace period entirely and escalate immediately. See [Stopping a stuck service](#stopping-a-stuck-service) for the UI's "Force Stop" button and `dsd stop --force`.

> **Note:** **Restart** tears down whatever is in flight first: a live process (including one still coming up in `starting`/`finalizing`), or an in-flight `beforeStart` hook (`initializing`), which it aborts. An already `stopped`/`error`/`crashed` service it just starts. After tearing down a live process it waits a brief fixed settle pause (500ms) before starting again, giving the OS time to release the old process's resources (e.g. its listening port) so the fresh process doesn't immediately hit `EADDRINUSE` on a fast restart. (Restarting from `initializing` has no process to release, so that pause is skipped.)

On POSIX, services are spawned **detached** so each leads its own process group, and (by default) stop signals the **whole group** (not just the process you launched). This matters because many dev commands are wrappers, such as `bun run`, `npm run`, `vite`, `nodemon`, or a shell script, that fork the actual server as a child. Signaling only the wrapper can leave that child alive holding its port, so the next start fails with `EADDRINUSE`. Group termination reaps the wrapper and its children together.

The two behaviors below are independent. One changes how the graceful `SIGTERM` is delivered, and the other is always part of the force-kill step:

- **`gracefulShutdown: true`** (per service): changes only the **graceful** `SIGTERM` to target just the main process instead of the group, so it can coordinate shutting down its own children (useful for testing your app's graceful shutdown / signal forwarding). In this mode the main process is **responsible for its own children**: if it doesn't exit within the stop timeout it's force-killed (whole group) as a safety net, but if it exits cleanly the dashboard does **not** touch its children, so a graceful service that exits while leaving a child alive can orphan it. (The default path, by contrast, group-kills on the leader's exit, so it never orphans.) Default is to signal the whole group on `SIGTERM` too. This flag has **no effect on Windows**, where process groups aren't used and stop always signals just the launched process.
- **Escaped-children fallback**: runs as part of the force-kill (`SIGKILL`) step (when a service has to be force-killed because it didn't exit in time). The dashboard also walks the live process tree (via `ps`) and kills any descendants that left the process group (e.g. via `setsid`) which the group signal missed. Fully daemonized children (double-fork, reparented to init) are outside any tracking and won't be reaped.
- **Windows**: process groups aren't used. Stop signals just the launched process. Tree termination would require `taskkill /T` (not currently implemented), so wrapper-spawned children may survive. The dashboard is primarily tested on macOS/Linux.

### Logger Configuration

Dev Services Dashboard supports pluggable logging to integrate with your existing logging infrastructure or to disable logging entirely.

#### No Logging by Default

By default, Dev Services Dashboard doesn't log anything unless you provide a logger. Note that some non-fatal diagnostics are emitted **only** through this logger, for example an unknown `dependsOn` id being dropped or a refused signal, so they are silent unless you configure a `logger`. (A few user-facing notices, like a refused custom signal, are also written to the affected service's log stream and so still appear in the UI regardless.)

```typescript
import { startDevServicesDashboard } from "dev-services-dashboard";

// No internal logging
startDevServicesDashboard({
  services: [...],
});
```

#### Using the Console Logger

To enable console logging, use the provided console logger factory. It takes an optional `enabled` flag (default `true`), so `createConsoleLogger()` logs and `createConsoleLogger(false)` is a no-op:

```typescript
import { startDevServicesDashboard, createConsoleLogger } from "dev-services-dashboard";

// Enable console logging
startDevServicesDashboard({
  services: [...],
  logger: createConsoleLogger(),
});

// For easy on/off control based on environment
const LOGGING_ENABLED = process.env.NODE_ENV === "development";
startDevServicesDashboard({
  services: [...],
  logger: createConsoleLogger(LOGGING_ENABLED),
});
```

#### Creating a Custom Logger

You can provide your own logger function:

```typescript
import { startDevServicesDashboard, type DevServicesDashboardLoggerFunction } from "dev-services-dashboard";

const customLogger: DevServicesDashboardLoggerFunction = (type, message, data) => {
  // Integrate with your logging system
  myLogger.log({
    level: type,
    message,
    data,
    service: "dev-services-dashboard"
  });
};

startDevServicesDashboard({
  services: [...],
  logger: customLogger,
});
```

#### Disabling Logging

To disable all Dev Services Dashboard internal logging:

```typescript
import { startDevServicesDashboard } from "dev-services-dashboard";

// Provide a no-op logger
startDevServicesDashboard({
  services: [...],
  logger: () => {}, // No logging
});
```

## Example

```typescript
// scripts/dev-ui-runner.ts
import {
  startDevServicesDashboard,
  type UserServiceConfig,
} from "dev-services-dashboard";

const services: UserServiceConfig[] = [
  {
    id: "db",
    name: "Database (Postgres)",
    command: ["bun", "run", "scripts/dev-db.ts"],
    webLinks: [{ label: "Admin Panel", url: "http://localhost:5432/admin" }],
  },
  {
    id: "api",
    name: "API Server",
    command: ["bun", "run", "src/apps/api-server/index.ts"],
    env: { NODE_ENV: "development" },
    webLinks: [
      { label: "API Docs", url: "http://localhost:3001/docs" },
      { label: "Health Check", url: "http://localhost:3001/health" },
    ],
  },
  {
    id: "ssr",
    name: "SSR Server (Main Website)",
    command: ["bun", "run", "src/apps/main-website/ssr-server.ts"],
    env: { NODE_ENV: "development" },
    webLinks: [
      { label: "Website", url: "http://localhost:3000" },
      { label: "Dev Tools", url: "http://localhost:3000/__dev" },
    ],
  },
];

const dashboard = await startDevServicesDashboard({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  services,
});

console.log("Dev Services Dashboard started");

// The library installs no signal handlers, so own shutdown yourself.
let isShuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  // A second Ctrl+C while the graceful stop is still running forces an exit.
  if (isShuttingDown) process.exit(1);
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down…`);
  try {
    await dashboard.stop(); // stop all services, then close the server
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

## CLI & Control API

Everything the web UI can do (list services, check status, start/stop/restart, read logs, send signals) is also available from the terminal, over an HTTP control API and a bundled `dsd` command. This exists mainly so **scripts and AI coding agents can drive your dev stack** without a browser: an agent can ask whether the API server is running, read the last 50 lines after a crash, and restart it after editing the code.

### How it fits together

The CLI is a **client for a dashboard that is already running**. It does not start the dashboard and does not read your config. You keep booting it however you do today (`bun run dev`), and the CLI talks to that process:

```bash
# Terminal 1: your usual runner script
bun run dev

# Terminal 2 (or your agent)
dsd status
```

This is deliberate: your service config is TypeScript containing `beforeStart` / `afterStart` **functions**, which no standalone config file could express. Pointing the CLI at the live dashboard keeps one source of truth.

Both `dev-services-dashboard` and the shorter `dsd` are installed as binaries. With a local install, run them via `bunx dsd …` / `npx dsd …`, or add a script to your `package.json`.

### Connecting

The dashboard URL is resolved in this order:

1. `--url http://localhost:4000`
2. `$DEV_SERVICES_DASHBOARD_URL`
3. `$DSD_URL`
4. `http://localhost:4000` (the library's own default)

### Commands

| Command                           | What it does                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `dsd status` (`ls`, `list`, `ps`) | Table of every service with status, pid, and log count                        |
| `dsd status <service>`            | One service in detail                                                         |
| `dsd status [<service>] --check`  | Exit `3` unless it's running, for `dsd status api --check \|\| dsd start api` |
| `dsd start <service>`             | Start it and **wait** for the outcome                                         |
| `dsd stop <service>`              | Stop it and wait for it to terminate                                          |
| `dsd stop <service> --force`      | Skip the grace period and SIGKILL it now                                      |
| `dsd stop-all --force`            | Same, for every service, including any already stuck `stopping`               |
| `dsd restart <service>`           | Restart it and wait for it to come back up                                    |
| `dsd start-all` / `dsd stop-all`  | Start/stop everything in (reverse) dependency order                           |
| `dsd logs <service>`              | Buffered log lines, newest last                                               |
| `dsd logs <service> -f`           | Stream new lines as they arrive (Ctrl+C to stop)                              |
| `dsd clear-logs <service>`        | Clear a service's log buffer                                                  |
| `dsd signal <service> <SIGNAL>`   | Send a signal the service declares in `signals`                               |
| `dsd health` (`ping`)             | Check a dashboard is reachable                                                |
| `dsd help [<command>]`            | Help; `dsd help --json` emits the full machine-readable manifest              |

Useful flags: `--json` (machine-readable output), `-f`/`--follow`, `--lines <n>`, `--type stdout,stderr,system`, `--since <epoch-ms>`, `--plain` (bare log lines, no timestamp prefix), `--force`, `--grace <ms>`, `--no-wait`, `--timeout <ms>`, `--no-color`.

```bash
dsd status
dsd logs api --lines 50 --type stderr
dsd logs api -f
dsd restart api && dsd status api
dsd signal api SIGHUP
```

### Stopping a stuck service

A normal stop sends `SIGTERM`, waits out the service's `stopTimeout` (5s by default, overridable per service), and only then escalates to `SIGKILL`. That's the right default, but it means a process that ignores `SIGTERM` leaves you watching a `stopping` spinner for the whole grace period.

`--force` skips straight to `SIGKILL` on the process group, after the same escaped-descendant sweep the timeout path does:

```bash
dsd stop api --force
```

It also works on a service **already** stuck in `stopping`, which is the case it really exists for. Rather than starting a second stop, it cuts short the grace period of the one already in flight, and the original caller settles normally too.

The web UI mirrors this: while a stop is in flight, the **Stop** button becomes a pulsing **Force Stop** instead of greying out, sending the same request. The header's **Stop All** does the same, becoming **Force Stop All** while a run is under way, and a forced run also sweeps up services already stuck `stopping` from the run it's escalating, which a normal stop-all skips.

> Note this is different from sending `SIGKILL` through the signals dropdown (or `dsd signal`). Signals must be declared in the service's `signals` config, are delivered only to the main process, and don't move the service to `stopping` or reap escaped descendants. A force stop is a stop; it just skips the polite phase.

### Going faster in a restart loop

`--grace <ms>` overrides the SIGTERM grace period for a single request, instead of the service's configured `stopTimeout`. It's aimed at automation: a script or agent restarting a service on every edit pays that grace period every cycle, and usually knows its own service shuts down far quicker than the configured default allows for.

```bash
dsd restart api --grace 300   # 300ms to exit cleanly, then SIGKILL
dsd restart api --force       # don't even ask
```

Against a service that ignores SIGTERM with `stopTimeout: 60000`, a plain `dsd restart` takes just over 60s; `--grace 300` takes 0.9s and `--force` 0.6s.

Like `--force`, it reaches a service **already** stuck in `stopping`: rather than starting a second stop, it re-arms the grace period of the one already in flight (measured from the moment of the request), so a shorter deadline cuts the remaining wait short. The original caller settles with it.

It works on `stop`, `restart`, and `stop-all`, and over HTTP as `{"graceMs": 300}`. `graceMs` must be a **positive integer** no greater than `2147483647` (the largest delay `setTimeout` can hold). `0` is rejected rather than silently meaning "no grace period", so `force` stays the one explicit way to ask for an immediate kill, and an oversized value is rejected rather than silently clamped to an immediate kill.

There is no UI control for this one: it's a numeric knob for automation, where Force Stop is the human affordance. Note also that a restart's fixed 500ms settle pause (which lets the OS release the old process's port) is deliberately not overridable, since it guards a real race, and shortening it would trade a rare hang for a much more annoying flaky start.

### Following logs

`dsd logs <service> -f` streams new lines as they arrive, like `tail -f`. It replays the last 10 buffered lines first (or `-n <count>` of them), then stays connected until you Ctrl+C.

```bash
dsd logs api -f                  # follow
dsd logs api -f -n 50            # replay 50 lines, then follow
dsd logs api -f --type stderr    # errors only
dsd logs api -f --json           # NDJSON: one JSON object per line
```

This is the one command that uses the dashboard's WebSocket rather than the HTTP API. The server already broadcasts every log line to connected clients, so following is just a matter of listening, and the opening frame carries the buffered tail.

A few details worth knowing:

- Only log lines go to **stdout**. Status changes ("api is now crashed") and notices go to **stderr**, so `dsd logs api -f | grep ERROR` sees log output only.
- Under `--json` the output is **NDJSON** (one object per line, not a JSON array), so a consumer can read it incrementally instead of waiting for a document that never ends.
- Ctrl+C exits `0`. Ending a follow is what Ctrl+C is _for_ here, so it counts as success. (Everywhere else, Ctrl+C cuts a command short before its outcome is known and exits `130`.) If the dashboard goes away mid-follow, it exits `5` (unreachable) rather than pretending the stream ended normally.
- `--since` is a query against the stored buffer, so it can't be combined with `--follow`.

### Exit codes

The real contract for scripts and agents (output wording may change, these won't):

| Code  | Meaning                                                                        |
| ----- | ------------------------------------------------------------------------------ |
| `0`   | Success                                                                        |
| `1`   | Internal error                                                                 |
| `2`   | Usage error (unknown command or flag, missing argument)                        |
| `3`   | Operation failed (didn't start, `--check` failed, a bulk run had failures)     |
| `4`   | No such service                                                                |
| `5`   | Dashboard unreachable                                                          |
| `6`   | Dashboard is shutting down                                                     |
| `7`   | Signal not allowed (not declared in the service's `signals`)                   |
| `8`   | Unexpected API response                                                        |
| `130` | Interrupted by Ctrl+C before completing (not `logs --follow`, which exits `0`) |

Under `--json`, successful output is a single JSON object on **stdout**, and errors are JSON on **stderr** (`{"ok":false,"error":{"code","message"},"exitCode":N}`), so stdout stays clean for piping.

### HTTP control API

The CLI is a thin wrapper over `/api/v1`, so plain `curl` works just as well, handy for an agent that doesn't have the CLI installed.

| Method   | Path                                     | Notes                                                    |
| -------- | ---------------------------------------- | -------------------------------------------------------- |
| `GET`    | `/api/v1`                                | Self-describing route index                              |
| `GET`    | `/api/v1/health`                         | `{dashboardName, shuttingDown, serviceCount, uptimeMs}`  |
| `GET`    | `/api/v1/services`                       | Every service with its status                            |
| `GET`    | `/api/v1/services/:id`                   | One service                                              |
| `POST`   | `/api/v1/services/:id/start`             | Body `{"wait":false}` to return immediately (`202`)      |
| `POST`   | `/api/v1/services/:id/stop`              | Body `{"force":true}` or `{"graceMs":N}`                 |
| `POST`   | `/api/v1/services/:id/restart`           | Body `{"wait":false}`, `{"force":true}`, `{"graceMs":N}` |
| `POST`   | `/api/v1/services/:id/signal`            | Body `{"signal":"SIGHUP"}`                               |
| `GET`    | `/api/v1/services/:id/logs`              | Query: `limit`, `since`, `logType`, `format=text`        |
| `DELETE` | `/api/v1/services/:id/logs`              | Clear the buffer                                         |
| `POST`   | `/api/v1/start-all` / `/api/v1/stop-all` | Counts for the run; stop-all takes `force` / `graceMs`   |

```bash
curl localhost:4000/api/v1/services
curl 'localhost:4000/api/v1/services/api/logs?limit=50&format=text'
curl -X POST -H 'Content-Type: application/json' localhost:4000/api/v1/services/api/restart
```

**`Content-Type: application/json` is required on every POST** (see Security below). A POST without it is rejected with `415`.

Failures return a non-2xx status and `{"ok":false,"error":{"code","message"}}`. Branch on `error.code`, not the message: `service_not_found`, `start_failed`, `stop_failed`, `service_not_running`, `start_all_busy`, `signal_not_allowed`, `shutting_down`, `bad_request`, `not_found`, `method_not_allowed`, `unsupported_media_type`, `forbidden_origin`, `internal_error`.

Two behaviors worth knowing:

- **`start` and `restart` block by default** until the service settles, so the response reflects the real outcome rather than "accepted". With hooks configured that can take up to `beforeStartTimeout + startTimeout + afterStartTimeout` (~130s with the defaults), which is why the CLI applies no client-side deadline to these commands. Pass `{"wait":false}` for fire-and-forget.
- **A start "succeeds" once the process spawns.** A service that exits immediately afterwards will report success and then show `error` on the next `status`, the same semantics the web UI's Start All has always had. If a fast-exiting service matters to you, follow a start with `dsd status <service> --check`.
- **The log buffer is a ring buffer** capped at `maxLogLines`. A logs response includes `bufferSize`, `bufferLimit`, and `truncated`; when `truncated` is true, older lines have already been evicted, so a `since`-based poller may have missed some.

### Security

The control API has **no authentication** and is exactly as trusted as the web UI: anything that can reach the port can start, stop, and signal processes on your machine. That's fine for the default `localhost` binding, and is the same reason the [binding warning](#configuration-options) tells you not to expose the dashboard on an untrusted network.

Because a REST API is reachable from a web page in a way a WebSocket isn't, two guards are applied to mutating requests, neither of which involves tokens:

- `Content-Type: application/json` is required, so a cross-origin POST can't slip through as a CORS "simple request".
- A request carrying a cross-origin `Origin` header is refused with `403`.

No `Access-Control-Allow-*` headers are ever sent.

### Using with AI agents

Point an agent at the CLI by dropping something like this into your `AGENTS.md` / `CLAUDE.md`:

```markdown
## Dev services

Local services run under a Dev Services Dashboard on http://localhost:4000.
Control them with the `dsd` CLI (add `--json` for machine-readable output):

- `dsd status`: list services and their status
- `dsd logs <service> --lines 50`: recent output
- `dsd restart <service>`: restart after changing its code
- `dsd status <service> --check`: exit 0 only if it is running

Prefer `--lines` over `dsd logs -f`: follow runs until interrupted, so only use
it with a timeout (e.g. `timeout 10 dsd logs api -f`).

In a fast edit/restart loop, `dsd restart <service> --grace 300` avoids waiting
out the full shutdown grace period on every cycle.

Exit codes: 0 ok, 2 usage, 3 failed, 4 no such service, 5 dashboard unreachable.
Run `dsd help --json` for the full command manifest.
```

## Demo

Want to see Dev Services Dashboard in action? We've included a demo with simulated services:

```bash
# Clone the repository
git clone https://github.com/keverw/dev-services-dashboard.git
cd dev-services-dashboard

# Install dependencies
bun install

# Run the demo (automatically builds frontend bundle)
bun run demo

# Or run the minimal tabs demo (only 3 services, perfect for testing non-scrolling tab behavior)
bun run demo-minimal-tabs
```

The demo includes simulated services that generate realistic logs:

- **Database Server**: SQL queries, connection management, and maintenance logs
- **API Server**: HTTP requests, middleware activity, and error scenarios
- **SSR Server**: Page rendering, hot reload, and build processes
- **Stubborn Service**: Ignores `SIGTERM` and keeps running, with a 15s `stopTimeout`

The stubborn service exists so you can actually see the stop escalation paths. Every other demo service exits on the first `SIGTERM`, so `stopping` flashes past and there's nothing to escalate. Start it, press **Stop**, and the button becomes a pulsing **Force Stop** for the 15 seconds it sits wedged (press **Stop All** instead and the header button becomes **Force Stop All**). From the terminal:

```bash
bun run dsd start stubborn
bun run dsd stop stubborn            # waits out the full 15s grace period
bun run dsd stop stubborn --force    # SIGKILL now, returns in well under a second
bun run dsd stop stubborn --grace 300
```

> **`bun run dsd` is a repo-only thing.** It's the `dsd` script in this project's `package.json`, which runs the CLI straight from TypeScript source so there's no build step between an edit and a test. In a project that installed the package, the command is just `dsd …` (or `bunx dsd …` / `npx dsd …` for a local install), as in the rest of this README.

With the demo running, a second terminal can drive it with the CLI straight from source (no build step), which is the easiest way to try or develop the `dsd` commands:

```bash
bun run dsd status
bun run dsd start api
bun run dsd logs api --lines 20
bun run dsd restart api --grace 300
```

The demo listens on the CLI's default URL (http://localhost:4000), so no `--url` is needed. Running from source reports version `0.0.0-dev` since the real version is only injected at build time.

Open http://localhost:4000 to explore the dashboard and try features like starting/stopping services, viewing real-time logs, "Start All" / "Stop All" (the demo wires up `dependsOn` so services come up in order), sending a custom signal to a running service, watching the API server's `beforeStart` warm-up (`initializing`) step, and the database's `afterStart` readiness/migration (`finalizing`) step.

## Development

Dev Services Dashboard is built with TypeScript and uses modern JavaScript features.

```bash
# Install dependencies
bun install

# Build the project (includes React frontend build)
bun run build

# Run tests
bun test

# Run the demo (includes frontend bundle generation)
bun run demo

# Develop the React frontend with hot reload
bun run dev-frontend

# Run the dsd CLI from source against a running dashboard (e.g. the demo)
bun run dsd status
```

**Note**: The React frontend is built using Vite and then bundled into a Virtual File System (VFS) during the build process. The generated `src/backend/frontend-vfs.ts` file is git-ignored as it's a build artifact, but it's required for the server to run. The demo command automatically builds the React frontend and generates this file before starting.

When preparing a new release:

1. Update the version in `package.json`
2. Update the `changelog.md` file with the new version and changes
3. Run the build command, which will automatically build the frontend assets VFS, lib distributable update the README version and changelog TOC

```bash
# Build the project (includes README version update)
bun run build
```

The build process first builds the React frontend using Vite, then creates the VFS bundle, and finally builds the backend library. It also uses the `update-readme` and `update-changelog` scripts defined in package.json. The `update-readme` script runs `markdown-toc-gen` to update the table of contents and then runs `scripts/update-readme-version.ts` to synchronize the version number in the README with the one in package.json. The `update-changelog` script also uses `markdown-toc-gen` to update the changelog's table of contents. Afterwards, you can publish the package to npm:

```bash
# Publish to npm
bun publish
```

Make sure to commit the new version back to GIT

### Project Structure

### backend

This is where the `startDevServicesDashboard` is imported from. This is responsible for managing the service underlying processes, the HTTP API and WebSocket Handler.

### frontend-react

This is where the React frontend source files are maintained. The frontend is built using Vite and TypeScript, providing a modern development experience with hot module replacement and type safety.

### frontend-build

This directory contains the built React application output from Vite. The build process compiles TypeScript, bundles JavaScript, and optimizes assets for production.

### Technical Details

The Dev Services Dashboard consists of:

- An HTTP server using Node's native `http` module that manages service processes and provides a WebSocket API
- WebSocket communication powered by the `ws` library
- A web interface that communicates with the server via WebSockets
- Real-time log streaming from services to the UI

The web interface talks to the server over two channels:

- **HTTP, once on load.** It fetches `/api/services-config` for the dashboard name and the service list (each service's `id`, `name`, `webLinks`, `signals`, and `dependsOn`). This renders the initial shell (tabs and title) and is the only place the dashboard name is sent.
- **WebSocket, on every connect.** The server sends an `initial_state` frame with the current per-service snapshot (`status`, buffered `logs`, `errorDetails`), and everything live after that flows over the socket: status changes, new logs, link updates, and Start All / Stop All progress. Since it's resent on every (re)connect, a client that drops and reconnects re-syncs whatever changed while it was away.

The `initial_state` frame is self-contained: it also carries each service's `id`, `name`, `webLinks`, `signals`, and `dependsOn` (see the exported `InitialStateService` type), so a consumer reading raw frames off the exposed `wsServer` doesn't need the HTTP endpoint at all. The HTTP/WebSocket split is just how the built-in UI happens to load.

If you're consuming frames yourself, the server also emits an `error_from_server` message (part of the exported `ServerMessage` union) in response to a client frame it can't act on: one that can't be processed (e.g. isn't valid JSON), names an unknown `serviceID`, uses an unrecognized `action`, or is a `send_signal` missing its `signal` field. It also replies with `error_from_server` ("Dashboard is shutting down.") to any client frame received once `stop()` has begun.

## Future Goals

- **Headless Mode**: An [HTTP control API and CLI](#cli--control-api) now cover the scripting/integration half of this. What's still open is a `serveUI: false` option to run the dashboard without serving the web interface at all
- **Streaming logs over plain HTTP**: `dsd logs -f` streams over the dashboard's WebSocket. A Server-Sent Events endpoint would let `curl -N` follow logs too, without a WebSocket client
- **Writing to a service's stdin**: services are spawned with stdin closed (`"ignore"`), so there's no way to type into a running process. Enabling it needs an opt-in per-service flag, a write path through the manager, and API/UI surface. Interactive prompts would additionally need a pty
- **Authentication & Security**: Currently designed for local development environments without authentication. Future versions could include optional authentication mechanisms for team environments or remote access scenarios
