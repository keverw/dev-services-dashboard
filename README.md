# Dev Services Dashboard v0.0.5

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
  - [Service Configuration](#service-configuration)
    - [Web Links](#web-links)
    - [Custom Signals](#custom-signals)
    - [Startup Ordering with dependsOn](#startup-ordering-with-dependson)
    - [Pre-start Hook (beforeStart)](#pre-start-hook-beforestart)
    - [Process termination](#process-termination)
  - [Logger Configuration](#logger-configuration)
    - [No Logging by Default](#no-logging-by-default)
    - [Using the Console Logger](#using-the-console-logger)
    - [Creating a Custom Logger](#creating-a-custom-logger)
    - [Disabling Logging](#disabling-logging)
- [Example](#example)
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

- **Real-time Logs**: View service logs as they happen
- **Service Controls**: Start, stop, restart services individually or all at once ("Start All" / "Stop All")
- **Status Monitoring**: Visual indicators for service status
- **Startup Ordering**: Declare `dependsOn` so services start in dependency order (and stop in reverse)
- **Custom Signals**: Send arbitrary POSIX signals (`SIGHUP`, `SIGUSR1`, …) to a running service from the UI
- **Pre-start Hooks**: Run an async `beforeStart` hook to prepare env/state before a service spawns
- **Web Links**: Quick access buttons to related URLs (docs, admin panels, health checks, etc.)
- **Connection Status**: Clear indication of connection state with automatic reconnection
- **Responsive Design**: Works on desktop and mobile devices

## Usage

### Quick Setup

1. **Install the package:**

   ```bash
   bun install dev-services-dashboard
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

   startDevServicesDashboard({
     dashboardName: "My Project Dashboard",
     port: 4000,
     hostname: "localhost",
     maxLogLines: 200,
     defaultCwd: process.cwd(),
     services,
     logger: createConsoleLogger(),
   });

   console.log("Dev Services Dashboard Started!");
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

| Option          | Type                               | Default                  | Description                                                                                                 |
| --------------- | ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `port`          | number                             | 4000                     | The port to run the Dev Services Dashboard server on                                                        |
| `hostname`      | string                             | 'localhost'              | The hostname to bind the server to                                                                          |
| `maxLogLines`   | number                             | 200                      | Maximum number of log lines to keep in memory per service                                                   |
| `defaultCwd`    | string                             | process.cwd()            | Default working directory for services                                                                      |
| `dashboardName` | string                             | 'Dev Services Dashboard' | Custom name for the dashboard displayed in the UI and page title                                            |
| `stopTimeout`   | number                             | 5000                     | Default ms to wait after SIGTERM before escalating to SIGKILL on stop (per-service `stopTimeout` overrides) |
| `services`      | UserServiceConfig[]                | required                 | Array of service configurations                                                                             |
| `logger`        | DevServicesDashboardLoggerFunction | none (no logging)        | Custom logger function for Dev Services Dashboard internal logs                                             |

### Service Configuration

Each service is defined with the following properties:

| Property           | Type                                                                 | Required | Description                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string                                                               | Yes      | Unique identifier for the service                                                                                                                                                                                           |
| `name`             | string                                                               | Yes      | Display name for the service                                                                                                                                                                                                |
| `command`          | string[]                                                             | Yes      | Command to run (first element is the executable, rest are arguments)                                                                                                                                                        |
| `cwd`              | string                                                               | No       | Working directory for the command (defaults to defaultCwd)                                                                                                                                                                  |
| `env`              | Record<string, string>                                               | No       | Environment variables to set for the process                                                                                                                                                                                |
| `webLinks`         | WebLink[]                                                            | No       | Array of web links to display as buttons in the service UI                                                                                                                                                                  |
| `signals`          | ServiceSignal[]                                                      | No       | Custom signals you can send to the running process from the UI ([Custom Signals](#custom-signals))                                                                                                                          |
| `dependsOn`        | string[]                                                             | No       | IDs of services this one depends on; affects Start All / Stop All ordering ([Startup Ordering](#startup-ordering-with-dependson))                                                                                           |
| `beforeStart`      | (ctx: BeforeStartContext) => Promise<BeforeStartResult \| void>      | No       | Async hook run before the process spawns; may return `{ env?, webLinks? }` ([Pre-start Hook](#pre-start-hook-beforestart))                                                                                                   |
| `gracefulShutdown` | boolean                                                              | No       | Send the stop `SIGTERM` to only the main process (so it can shut down its own children) instead of the whole group. Forced `SIGKILL` still targets the group. Default `false` ([Process termination](#process-termination)) |
| `stopTimeout`      | number                                                               | No       | Ms to wait after SIGTERM before escalating to SIGKILL for this service (overrides the global `stopTimeout`). Default `5000`                                                                                                 |

#### Web Links

Web links appear as clickable buttons in each service's control panel. Each web link is defined with:

| Property | Type   | Required | Description                            |
| -------- | ------ | -------- | -------------------------------------- |
| `label`  | string | Yes      | Display text for the link button       |
| `url`    | string | Yes      | URL to open when the button is clicked |

**Note**: The URLs in the examples below are for demonstration purposes. Make sure the URLs you configure actually correspond to running services or endpoints that your services expose.

#### Custom Signals

Services can declare custom POSIX signals you can send to the running process from the dashboard — handy for reloading config (`SIGHUP`), rotating logs, or triggering app-specific behavior (`SIGUSR1` / `SIGUSR2`). When the service is running, a **"Send signal…"** dropdown appears in its control bar; it's disabled when the service isn't running.

Each signal is defined with:

| Property | Type   | Required | Description                               |
| -------- | ------ | -------- | ----------------------------------------- |
| `label`  | string | Yes      | Display text shown in the signal dropdown |
| `signal` | string | Yes      | Signal name to send (e.g. `SIGHUP`)       |

Signals are validated on the backend against `os.constants.signals`; an unknown signal name is ignored (and logged) rather than sent.

```typescript
{
  id: "api",
  name: "API Server",
  command: ["bun", "run", "src/apps/api-server/index.ts"],
  signals: [
    { label: "Reload config", signal: "SIGHUP" },
    { label: "Reopen logs", signal: "SIGUSR1" },
  ],
}
```

#### Startup Ordering with dependsOn

Services can declare dependencies with `dependsOn` (an array of service `id`s). The dashboard topologically sorts services once at startup so dependencies start before the services that rely on them.

- **Start All** starts services in dependency order. Because it waits for each service to be `running` before moving on, a dependent naturally starts only after its dependency is up. If a service fails, only its (transitive) dependents are skipped — unrelated services keep starting, and a summary reports how many were skipped.
- **Stop All** stops services sequentially in **reverse** order, so dependents shut down before the dependencies they rely on.
- Starting a **single** service manually whose dependencies aren't running shows a non-blocking warning but still starts it — `dependsOn` is an orchestration hint, not enforced runtime wiring.
- An unknown dependency `id` is ignored with a warning. A **self-dependency** or a dependency **cycle** is a fatal configuration error — the dashboard refuses to start (the error message includes the cycle path).

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

#### Pre-start Hook (beforeStart)

Each service can define an async `beforeStart` hook that runs **before** the process spawns — useful for waiting on a dependency's port, running a migration, or resolving secrets. While the hook runs, the service shows an `initializing` status (and "Start All" won't time out waiting for it).

The hook receives a `BeforeStartContext`:

| Property   | Type                   | Description                                                        |
| ---------- | ---------------------- | ------------------------------------------------------------------ |
| `env`      | Record<string, string> | The merged env (process env + service `env`) bound for the process |
| `webLinks` | WebLink[]              | The service's currently configured web links                       |
| `log`      | (line: string) => void | Writes a line to the service's log stream                          |
| `signal`   | AbortSignal            | Aborts if the service is stopped while the hook is still running   |

The hook may return an object to customize the launch (any field left out keeps its current value):

| Field      | Type                   | Effect                                                         |
| ---------- | ---------------------- | -------------------------------------------------------------- |
| `env`      | Record<string, string> | Replaces the env passed to the spawned process                 |
| `webLinks` | WebLink[]              | Replaces the service's web links, pushed live to the dashboard |

Return nothing to leave both unchanged. If the hook throws, the service is put into the `error` state — the dashboard keeps running. If the user stops the service mid-hook, `signal` is aborted and the service returns to `stopped` (the process is never spawned).

> **Note:** `beforeStart` runs _before_ the process spawns, so any `webLinks` you return must be computable up front (e.g. derived from a resolved port/region). Links only known _after_ the process starts (a tunnel URL, a randomly-assigned port printed to stdout) are out of scope for this hook.

**Common uses:**

- **Wait for a dependency** — block until a database/cache port is accepting connections (or a migration finishes) before the service spawns.
- **Inject short-lived / scoped credentials** — rather than baking secrets into config, resolve them per-launch and return them in the env. For example: fetch a fresh token from a local Vault/KMS/enclave emulator (`vault server -dev`), point a service at LocalStack instead of real S3, or mint a restricted sandbox API key so a dev process can't accidentally hit production with full credentials. The `log()` callback lets you surface progress ("Fetching dev credentials…") and `signal` lets you bail cleanly if the user stops the service mid-fetch.
- **Resolve web links at launch** — return `webLinks` to swap in URLs computed from the resolved config (e.g. the port/region this run will use).

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

#### Process termination

Stopping a service sends `SIGTERM`, then escalates to `SIGKILL` if it hasn't exited within the stop timeout (default 5000ms — configurable globally via `stopTimeout` or per service via `stopTimeout`).

On POSIX, services are spawned **detached** so each leads its own process group, and (by default) stop signals the **whole group** (not just the process you launched). This matters because many dev commands are wrappers — `bun run`, `npm run`, `vite`, `nodemon`, a shell script — that fork the actual server as a child. Signaling only the wrapper can leave that child alive holding its port, so the next start fails with `EADDRINUSE`. Group termination reaps the wrapper and its children together.

The two behaviors below are independent — one changes how the graceful `SIGTERM` is delivered, the other is always part of the force-kill step:

- **`gracefulShutdown: true`** (per service) — changes only the **graceful** `SIGTERM` to target just the main process instead of the group, so the process can coordinate shutting down its own children (useful for testing your app's graceful shutdown / signal forwarding). The forced `SIGKILL` still targets the whole group as a safety net, so a non-forwarding wrapper still can't orphan children. Default is to signal the whole group on `SIGTERM` too.
- **Escaped-children fallback** — **always** runs as part of the force-kill (`SIGKILL`) step, regardless of `gracefulShutdown`. When a service has to be force-killed, the dashboard also walks the live process tree (via `ps`) and kills any descendants that left the process group (e.g. via `setsid`) which the group signal missed. Fully daemonized children (double-fork, reparented to init) are outside any tracking and won't be reaped.
- **Windows** — process groups aren't used; stop signals just the launched process. Tree termination would require `taskkill /T` (not currently implemented), so wrapper-spawned children may survive. The dashboard is primarily tested on macOS/Linux.

### Logger Configuration

Dev Services Dashboard supports pluggable logging to integrate with your existing logging infrastructure or to disable logging entirely.

#### No Logging by Default

By default, Dev Services Dashboard doesn't log anything unless you provide a logger:

```typescript
import { startDevServicesDashboard } from "dev-services-dashboard";

// No internal logging
startDevServicesDashboard({
  services: [...],
});
```

#### Using the Console Logger

To enable console logging, use the provided console logger factory:

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

startDevServicesDashboard({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  services,
});

console.log("Dev Services Dashboard started");
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

Open http://localhost:4000 to explore the dashboard and try features like starting/stopping services, viewing real-time logs, "Start All" / "Stop All" (the demo wires up `dependsOn` so services come up in order), sending a custom signal to a running service, and watching the API server's `beforeStart` warm-up (`initializing`) step.

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

## Future Goals

- **Headless Mode**: Support running Dev Services Dashboard without serving the web interface, ideal for building IDE extensions or integrating with other development tools
- **Authentication & Security**: Currently designed for local development environments without authentication. Future versions could include optional authentication mechanisms for team environments or remote access scenarios
