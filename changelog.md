# Change Log

<!-- toc -->

- [0.0.1 (June 7, 2025)](#001-june-7-2025)
- [0.0.2 (June 7, 2025)](#002-june-7-2025)
- [0.0.3 (June 8, 2025)](#003-june-8-2025)
- [0.0.4 (June 8, 2025)](#004-june-8-2025)
- [0.0.5 (June 8, 2025)](#005-june-8-2025)
- [0.1.0 (June 17, 2026)](#010-june-17-2026)
  - [Features](#features)
  - [UX / fixes](#ux--fixes)
  - [Tests](#tests)
  - [Build / tooling](#build--tooling)

<!-- tocstop -->

## 0.0.1 (June 7, 2025)

- Initial Version

## 0.0.2 (June 7, 2025)

- Metadata edits, dependency cleanup

## 0.0.3 (June 8, 2025)

- Converted the frontend to React instead of Vanilla JS to make future edits easier
- Better Loading State
- Tailwind Conversion, UX improvements like if you add a bunch fo tabs it will scroll them
- Dark Mode Support!
- Custom Dashboard Name: Added `dashboardName` configuration option to customize the dashboard title displayed in the UI and browser tab
- Branding Color Consistency - Edited Header to use same color as Icon, and edited Icon terminal section to dark the one in dark mode, Border matches dark mode background color

## 0.0.4 (June 8, 2025)

- Version bump to update docs on NPM after better setup guide

## 0.0.5 (June 8, 2025)

- Fixed macOS trackpad scrolling issue where phantom scroll arrows would appear even with only 3 tabs
- Added dynamic overflow control: `overflow-x: hidden` when no scrolling needed, `overflow-x: auto` when scrolling required
- Added minimal tabs demo (`bun run demo-minimal-tabs`) for testing non-scrolling tab behavior
- Improved scroll detection with 10px threshold to prevent trackpad micro-scrolling false positives
- Visual consistency improvements: Standardized border colors and spacing across light/dark modes
  - Unified border colors to use `gray-300` (light) and `gray-600` (dark) for service headers, button separators, logs dividers, and logs area
  - Added consistent border styling to logs area for better visual definition
  - Improved spacing balance around logs section divider and controls for better visual hierarchy

## 0.1.0 (June 17, 2026)

### Features

- **Stop All** — a "Stop All" button in the header (alongside "Start All") stops every running service in reverse dependency order (dependents before the services they depend on). Disabled when nothing is running.
- **Custom signals** — services can declare a `signals` list (`{ label, signal }`). When a service is running, a "Send signal…" dropdown appears in its control bar that sends the chosen POSIX signal (e.g. `SIGHUP` to reload config) to the process. Unknown signal names are ignored.
- **`dependsOn` startup ordering** — services can declare a `dependsOn: string[]` list so they start in dependency order (dependencies before their dependents). Unknown dependency IDs are ignored with a warning; a self-dependency or a cycle is a configuration error that refuses startup. "Start All" skips only the (transitive) dependents of a service that fails — unrelated services keep starting — and reports how many were skipped; "Stop All" stops in reverse order. Manually starting a single service whose dependencies aren't running shows a non-blocking warning (e.g. "Starting api, but db is stopped") but still starts it — `dependsOn` is an ordering hint, not an enforced constraint.
- **`beforeStart` hook** — services can declare an async `beforeStart(ctx)` hook that runs before the process spawns. It receives the merged `env`, the current `webLinks`, a `log()` callback that writes to the service's log stream, and an `AbortSignal` that fires if the service is stopped while the hook runs. It may return `{ env?, webLinks? }` to customize the environment passed to the process and/or update the service's web links (which refresh live in the dashboard); throwing puts the service into the `error` state without crashing the dashboard. While the hook runs the service shows a new `initializing` status, and "Start All" waits for it rather than timing out.

### UX / fixes

- Added an "Overview" button in the header that shows a grid of every service with its current status; clicking a card jumps straight to that service's tab — handy when there are more services than fit in the tab bar.
- The Stop and Restart buttons now visually appear disabled (greyed out) when they're not applicable, instead of staying colored while being unclickable.
- The wait before a stuck service is force-killed on stop is now configurable — globally via `stopTimeout` (ms) in the dashboard config, or per service via `stopTimeout` (overrides the global). Default 5000ms.
- Stopping a service now also terminates the child processes it spawned — e.g. a `bun run` / `vite` / `nodemon` wrapper's underlying dev server — so they no longer linger holding ports and cause `EADDRINUSE` on the next start. (POSIX, including best-effort cleanup of children that detached into their own group; on Windows only the launched process is signaled.)
- Added a per-service `gracefulShutdown` option: when enabled, the stop signal goes only to the service's main process so it can shut down its own children (handy for testing graceful shutdown), with a forced kill of the whole tree as a safety net. Default off.
- A service that has crashed can now be started or restarted again from the dashboard — previously the Start/Restart buttons looked enabled but did nothing. Starting it also clears the error.
- Toast notifications now slide in cleanly instead of briefly appearing in place and then jumping in from the edge — most noticeable when several arrive at once.
- Toasts now animate out smoothly and neighbors glide into place instead of snapping, including on auto-dismiss and when older toasts are pushed out by newer ones.
- "Start All" now shows a single live progress toast (`Starting services… (n/total)`) that updates in place and ends in a summary, instead of a toast per service. Failures still surface their own error toast.
- Fixed services not showing as "Disconnected" when the connection drops, and some notifications showing a service's internal id instead of its name.
- Light/dark theme switching now fades smoothly instead of snapping (and doesn't animate on the initial page load).

### Tests

- Added `service-manager.test.ts` — unit tests that exercise `ServiceManager` directly (no HTTP/WS stack) covering core lifecycle, custom signals, `dependsOn` ordering, and the `beforeStart` hook. Also covers stdout/stderr log piping, the process `error` event, and recovery from a `crashed` state.
- Added `logger.test.ts` covering `createConsoleLogger` (enabled/disabled/default) and the `Logger` wrapper.
- Added WebSocket integration tests for the new `send_signal` (missing-signal validation) and `stop_all` actions.
- Raised backend coverage from ~89% to ~94% lines; `service-manager.ts` and `logger.ts` are now at 100%.

### Build / tooling

- Added `typecheck` script (`tsc --noEmit`) for backend TypeScript validation
- Added `prepublishOnly` script — runs lint, typecheck, audit, and build before every publish
- Upgraded all devDependencies to latest (ESLint 10, Vite 8, tsup, @typescript-eslint 8, etc.)
- Upgraded `ws` runtime dependency to 8.21.0 (security fixes)
- Added `overrides` for `rollup`, `esbuild`, `picomatch`, `flatted`, `@babel/core` to resolve transitive devDep vulnerabilities — `bun audit` now reports no vulnerabilities
- Created `eslint.config.mjs` (ESLint v9+ flat config) with TypeScript, React, React Hooks, and jsx-a11y rules
- Fixed `tsconfig.json` to exclude `src/frontend-react` (which has its own tsconfig/Vite toolchain) so `tsc --noEmit` only checks the published library code
- Fixed pre-existing lint errors surfaced by the new config (`any` types, unused vars, `ToastContext` forward-reference bug)
- Cleared all remaining React Hooks lint warnings — `bun run lint` is now warning-free: derived `theme` in `ThemeContext` instead of mirroring it into state via an effect, removed a redundant `activeTabId` read from the mount-only load effect, deleted the unused legacy `Toast.tsx` component, and added scoped suppressions (with reasons) for the intentional mount-once WebSocket effect and two `Date.now()` calls in non-render event handlers
