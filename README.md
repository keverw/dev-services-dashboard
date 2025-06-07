# Dev-UI v0.0.1

[![npm version](https://badge.fury.io/js/dev-ui.svg)](https://badge.fury.io/js/dev-ui)

![](DevUI-Icon.png)

A lightweight development UI dashboard for managing and monitoring multiple services during local development.

![Dev UI Dashboard](https://via.placeholder.com/800x450?text=Dev+UI+Dashboard)
_Screenshot: Dev UI dashboard showing multiple services_

[todo: include this!!!]

<!-- toc -->

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
  - [Basic Setup](#basic-setup)
  - [Configuration Options](#configuration-options)
  - [Service Configuration](#service-configuration)
- [Features](#features)
- [Technical Details](#technical-details)
- [Example](#example)
- [Demo](#demo)
- [Development](#development)
- [Project Structure](#project-structure)
  - [backend](#backend)
  - [frontend](#frontend)

<!-- tocstop -->

## Overview

Dev UI provides a web-based dashboard to:

- Start, stop, and restart development services
- Monitor service logs in real-time
- Track service status (running, stopped, error, etc.)
- Manage multiple services from a single interface

## Installation

```bash
bun install dev-ui
# or
npm add dev-ui
# or
yarn add dev-ui
```

## Usage

### Basic Setup

1. Import the library and define your services:

```typescript
import { startDevUI, type UserServiceConfig } from "dev-ui";

// Define your services
const services: UserServiceConfig[] = [
  {
    id: "db",
    name: "Database",
    command: ["bun", "run", "scripts/db-server.ts"],
  },
  {
    id: "api",
    name: "API Server",
    command: ["bun", "run", "src/apps/api-server/index.ts"],
    env: { NODE_ENV: "development" },
  },
];

// Start the DevUI
startDevUI({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  services,
});
```

2. Open your browser to `http://localhost:4000` to access the dashboard (or on your custom defined port)

### Configuration Options

The `startDevUI` function accepts a configuration object with the following properties:

| Option        | Type                | Default       | Description                                               |
| ------------- | ------------------- | ------------- | --------------------------------------------------------- |
| `port`        | number              | 4000          | The port to run the Dev UI server on                      |
| `hostname`    | string              | 'localhost'   | The hostname to bind the server to                        |
| `maxLogLines` | number              | 200           | Maximum number of log lines to keep in memory per service |
| `defaultCwd`  | string              | process.cwd() | Default working directory for services                    |
| `services`    | UserServiceConfig[] | required      | Array of service configurations                           |

### Service Configuration

Each service is defined with the following properties:

| Property  | Type                   | Required | Description                                                          |
| --------- | ---------------------- | -------- | -------------------------------------------------------------------- |
| `id`      | string                 | Yes      | Unique identifier for the service                                    |
| `name`    | string                 | Yes      | Display name for the service                                         |
| `command` | string[]               | Yes      | Command to run (first element is the executable, rest are arguments) |
| `cwd`     | string                 | No       | Working directory for the command (defaults to defaultCwd)           |
| `env`     | Record<string, string> | No       | Environment variables to set for the process                         |

## Features

- **Real-time Logs**: View service logs as they happen
- **Service Controls**: Start, stop, restart services individually or all at once
- **Status Monitoring**: Visual indicators for service status
- **Connection Status**: Clear indication of connection state with automatic reconnection
- **Responsive Design**: Works on desktop and mobile devices

## Technical Details

The Dev UI consists of:

- An HTTP server using Node's native `http` module that manages service processes and provides a WebSocket API
- WebSocket communication powered by the `ws` library
- A web interface that communicates with the server via WebSockets
- Real-time log streaming from services to the UI

## Example

```typescript
// scripts/dev-ui-runner.ts
import { startDevUI, type UserServiceConfig } from "dev-ui";

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
  },
  {
    id: "ssr",
    name: "SSR Server (Main Website)",
    command: ["bun", "run", "src/apps/main-website/ssr-server.ts"],
    env: { NODE_ENV: "development" },
  },
];

startDevUI({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  services,
});

console.log("DevUI started");
```

## Demo

Want to see Dev UI in action? We've included a demo with simulated services:

```bash
# Clone the repository
git clone https://github.com/keverw/dev-ui.git
cd dev-ui

# Install dependencies
bun install

# Run the demo (automatically builds frontend bundle)
bun run demo
```

The demo includes three simulated services that generate realistic logs:

- **Database Server**: SQL queries, connection management, and maintenance logs
- **API Server**: HTTP requests, middleware activity, and error scenarios
- **SSR Server**: Page rendering, hot reload, and build processes

Open http://localhost:4000 to explore the dashboard and try features like starting/stopping services, viewing real-time logs, and using the "Start All" functionality.

## Development

Dev UI is built with TypeScript and uses modern JavaScript features.

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun test

# Run the demo (includes frontend bundle generation)
bun run demo
```

**Note**: The frontend is bundled into a Virtual File System (VFS) during the build process. The generated `src/backend/frontend-vfs.ts` file is git-ignored as it's a build artifact, but it's required for the server to run. The demo command automatically generates this file before starting.

When preparing a new release:

1. Update the version in `package.json`
2. Update the `changelog.md` file with the new version and changes
3. Run the build command, which will automatically build the frontend assets VFS, lib distributable update the README version and changelog TOC

```bash
# Build the project (includes README version update)
bun run build
```

The build process uses the `update-readme` and `update-changelog` scripts defined in package.json. The `update-readme` script runs `markdown-toc-gen` to update the table of contents and then runs `scripts/update-readme-version.ts` to synchronize the version number in the README with the one in package.json. The `update-changelog` script also uses `markdown-toc-gen` to update the changelog's table of contents. Afterwards, you can publish the package to npm:

```bash
# Publish to npm
bun publish
```

Make sure to commit the new version back to GIT

## Project Structure

### backend

This is where the `startDevUI` is imported from. This is responsible for managing the service underlying processes, the HTTP API and WebSocket Handler.

### frontend

This is where the frontend files are maintained. Currently a single HTML file but in the future could be multiple files using a separately bundler. Then the frontend is turned into a single file, that the backend can export to serve up. This is handled by the `create-frontend-bundle` script, which build will call automatically.
