/**
 * Dev Services Dashboard Demo
 *
 * This demo showcases the Dev Services Dashboard functionality using simulated services
 * that generate realistic logs and demonstrate the dashboard capabilities.
 *
 * Based on the example from the README.md
 */

import {
  startDevServicesDashboard,
  type UserServiceConfig,
  createConsoleLogger,
} from "../src/backend/index";

console.log("🎬 Starting Dev Services Dashboard Demo...");
console.log("📖 This demo is based on the example from README.md");
console.log("🔧 Explicitly using the console logger (no logging by default)");
console.log("");

const services: UserServiceConfig[] = [
  {
    id: "db",
    name: "Database (PostgreSQL)",
    command: ["bun", "run", "scripts/demo-servers/db-server.ts"],
    // Note: These are demo URLs - they won't actually work since the demo servers don't expose these endpoints
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
    // Note: These are demo URLs - they won't actually work since the demo servers don't expose these endpoints
    webLinks: [
      { label: "API Docs", url: "http://localhost:3001/docs" },
      { label: "Health Check", url: "http://localhost:3001/health" },
      { label: "Swagger UI", url: "http://localhost:3001/swagger" },
    ],
  },
  {
    id: "ssr",
    name: "SSR Server (Main Website)",
    command: ["bun", "run", "scripts/demo-servers/ssr-server.ts"],
    env: { NODE_ENV: "development" },
    // Note: These are demo URLs - they won't actually work since the demo servers don't expose these endpoints
    webLinks: [
      { label: "Website", url: "http://localhost:3000" },
      { label: "Dev Tools", url: "http://localhost:3000/__dev" },
    ],
  },
];

// Explicitly use the console logger (Dev Services Dashboard doesn't log by default unless you provide a logger)
const demoLogger = createConsoleLogger(true); // Enable logging for demo

// Start the Dev Services Dashboard
startDevServicesDashboard({
  port: 4000,
  hostname: "localhost",
  maxLogLines: 200,
  services,
  logger: demoLogger,
});

console.log("");
console.log("🎉 Dev Services Dashboard Demo started!");
console.log("📍 Open your browser to: http://localhost:4000");
console.log("");
console.log("🔧 Demo Features:");
console.log("  • Three simulated services with realistic logs");
console.log("  • Database server with SQL queries and maintenance logs");
console.log("  • API server with HTTP requests and middleware logs");
console.log("  • SSR server with page rendering and hot reload logs");
console.log("  • Start/stop/restart individual services or all at once");
console.log("  • Real-time log streaming with auto-scroll");
console.log("  • Service status indicators and connection monitoring");
console.log("  • Web link buttons for quick access to related URLs");
console.log("");
console.log("💡 Try:");
console.log("  • Starting and stopping services");
console.log("  • Using the 'Start All' button");
console.log("  • Clicking web link buttons (note: demo URLs won't work)");
console.log("  • Clearing logs for individual services");
console.log("  • Toggling auto-scroll on/off");
console.log("  • Switching between service tabs");
console.log("");
console.log("Press Ctrl+C to stop the demo");
