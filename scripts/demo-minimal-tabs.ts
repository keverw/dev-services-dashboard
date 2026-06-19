/**
 * Dev Services Dashboard Demo - Minimal Tabs (No Scroll)
 *
 * This demo showcases the Dev Services Dashboard with only 3 services
 * to test tab navigation behavior when there's no overflow/scrolling needed.
 * Perfect for testing the macOS trackpad scrolling fix!
 */

import {
  startDevServicesDashboard,
  type UserServiceConfig,
  createConsoleLogger,
} from "../src/backend/index";

console.log("🎬 Starting Dev Services Dashboard Demo - Minimal Tabs...");
console.log(
  "📖 Testing tab navigation with only 3 services (no scroll needed)",
);
console.log("🔧 Perfect for testing macOS trackpad scrolling behavior!");
console.log("");

const services: UserServiceConfig[] = [
  {
    id: "db",
    name: "Database (PostgreSQL)",
    command: ["bun", "run", "scripts/demo-servers/db-server.ts"],
    webLinks: [
      { label: "DB Admin", url: "http://localhost:5432/admin" },
      { label: "Metrics", url: "http://localhost:5432/metrics" },
    ],
  },
  {
    id: "api",
    name: "API Server",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development" },
    webLinks: [
      { label: "API Docs", url: "http://localhost:3001/docs" },
      { label: "Health Check", url: "http://localhost:3001/health" },
    ],
  },
  {
    id: "ssr",
    name: "SSR Server (Main Website)",
    command: ["bun", "run", "scripts/demo-servers/ssr-server.ts"],
    env: { NODE_ENV: "development" },
    webLinks: [
      { label: "Website", url: "http://localhost:3000" },
      { label: "Dev Tools", url: "http://localhost:3000/__dev" },
    ],
  },
];

// Explicitly use the console logger
const demoLogger = createConsoleLogger(true);

// Start the Dev Services Dashboard. The library doesn't install any process
// signal handlers itself, so we own shutdown here: on Ctrl+C, stop the
// dashboard (which stops every service and closes the server) and then exit.
const dashboard = await startDevServicesDashboard({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  dashboardName: "Example Inc. Dev Services Dashboard",
  services,
  logger: demoLogger,
});

let isShuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  // A second Ctrl+C while the graceful stop is still running forces an exit.
  if (isShuttingDown) process.exit(1);
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down the demo...`);
  try {
    await dashboard.stop();
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("");
console.log("🎉 Minimal Tabs Demo started!");
console.log("📍 Open your browser to: http://localhost:4000");
console.log("");
console.log("🔧 Demo Features:");
console.log("  • Only 3 services - no tab scrolling needed");
console.log("  • Perfect for testing macOS trackpad scroll behavior");
console.log("  • Scroll arrows should NOT appear with trackpad scrolling");
console.log("  • Database, API, and SSR services");
console.log("");
console.log("💡 Test:");
console.log(
  "  • Try scrolling with macOS trackpad - arrows should stay hidden",
);
console.log("  • Resize browser window to test responsive behavior");
console.log("  • Switch between the 3 service tabs");
console.log("");
console.log("Press Ctrl+C to stop the demo");
