# Change Log

<!-- toc -->

- [0.0.1 (June 7, 2025)](#001-june-7-2025)
- [0.0.2 (June 7, 2025)](#002-june-7-2025)
- [0.0.3 (June 8, 2025)](#003-june-8-2025)
- [0.0.4 (June 8, 2025)](#004-june-8-2025)
- [0.0.5 (June 8, 2025)](#005-june-8-2025)

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

## 0.1.0 (June XXXX, 2026) (UNRELEASED)

### Build / tooling
- Added `typecheck` script (`tsc --noEmit`) for backend TypeScript validation
- Added `prepublishOnly` script — runs lint, typecheck, audit, and build before every publish
- Upgraded all devDependencies to latest (ESLint 10, Vite 8, tsup, @typescript-eslint 8, etc.)
- Upgraded `ws` runtime dependency to 8.21.0 (security fixes)
- Added `overrides` for `rollup`, `esbuild`, `picomatch`, `flatted`, `@babel/core` to resolve transitive devDep vulnerabilities — `bun audit` now reports no vulnerabilities
- Created `eslint.config.mjs` (ESLint v9+ flat config) with TypeScript, React, React Hooks, and jsx-a11y rules
- Fixed `tsconfig.json` to exclude `src/frontend-react` (which has its own tsconfig/Vite toolchain) so `tsc --noEmit` only checks the published library code
- Fixed pre-existing lint errors surfaced by the new config (`any` types, unused vars, `ToastContext` forward-reference bug)

