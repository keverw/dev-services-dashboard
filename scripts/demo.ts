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
    id: "db2",
    name: "Database 2 (MongoDB)",
    command: ["bun", "run", "scripts/demo-servers/db-server.ts"],
    // Note: These are demo URLs - they won't actually work since the demo servers don't expose these endpoints
    webLinks: [
      { label: "Mongo Express", url: "http://localhost:27017/admin" },
      { label: "Compass", url: "http://localhost:27017/compass" },
    ],
  },
  {
    id: "redis",
    name: "Redis Cache Server",
    command: ["bun", "run", "scripts/demo-servers/db-server.ts"],
    webLinks: [
      { label: "Redis Commander", url: "http://localhost:6379/admin" },
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
    id: "auth",
    name: "Authentication Service",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "auth" },
    webLinks: [
      { label: "Auth Dashboard", url: "http://localhost:3002/dashboard" },
      { label: "User Management", url: "http://localhost:3002/users" },
    ],
  },
  {
    id: "notifications",
    name: "Notification Service",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "notifications" },
    webLinks: [
      { label: "Email Queue", url: "http://localhost:3003/queue" },
      { label: "Templates", url: "http://localhost:3003/templates" },
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
  {
    id: "admin",
    name: "Admin Dashboard",
    command: ["bun", "run", "scripts/demo-servers/ssr-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "admin" },
    webLinks: [
      { label: "Admin Panel", url: "http://localhost:3004/admin" },
      { label: "Analytics", url: "http://localhost:3004/analytics" },
    ],
  },
  {
    id: "websocket",
    name: "WebSocket Server",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "websocket" },
    webLinks: [{ label: "WS Test Client", url: "http://localhost:3005/test" }],
  },
  {
    id: "search",
    name: "Elasticsearch Service",
    command: ["bun", "run", "scripts/demo-servers/db-server.ts"],
    webLinks: [
      { label: "Kibana", url: "http://localhost:9200/_plugin/kibana" },
      { label: "Head Plugin", url: "http://localhost:9200/_plugin/head" },
    ],
  },
  {
    id: "queue",
    name: "Message Queue (RabbitMQ)",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "queue" },
    webLinks: [{ label: "Management UI", url: "http://localhost:15672" }],
  },
  {
    id: "monitoring",
    name: "Monitoring & Metrics",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "monitoring" },
    webLinks: [
      { label: "Grafana", url: "http://localhost:3006/grafana" },
      { label: "Prometheus", url: "http://localhost:9090" },
    ],
  },
  {
    id: "longname",
    name: "Super Long Service Name That Should Get Truncated",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "longname" },
    webLinks: [
      { label: "Service Dashboard", url: "http://localhost:3007/dashboard" },
    ],
  },
  {
    id: "microservice1",
    name: "User Profile Management Microservice",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "microservice1" },
    webLinks: [{ label: "Profile API", url: "http://localhost:3008/api" }],
  },
  {
    id: "microservice2",
    name: "Payment Processing Gateway Service",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "microservice2" },
    webLinks: [
      { label: "Payment Dashboard", url: "http://localhost:3009/dashboard" },
    ],
  },
  {
    id: "microservice3",
    name: "Real-time Analytics and Reporting Engine",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "microservice3" },
    webLinks: [
      { label: "Analytics Portal", url: "http://localhost:3010/analytics" },
    ],
  },
  {
    id: "microservice4",
    name: "Content Delivery Network Management",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "microservice4" },
    webLinks: [
      { label: "CDN Control Panel", url: "http://localhost:3011/cdn" },
    ],
  },
  {
    id: "microservice5",
    name: "Machine Learning Model Training Pipeline",
    command: ["bun", "run", "scripts/demo-servers/api-server.ts"],
    env: { NODE_ENV: "development", SERVICE_NAME: "microservice5" },
    webLinks: [{ label: "ML Dashboard", url: "http://localhost:3012/ml" }],
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
console.log(
  "  • Twelve simulated services representing a full microservices stack",
);
console.log("  • Database servers (PostgreSQL, MongoDB, Redis, Elasticsearch)");
console.log("  • API services (Main API, Auth, Notifications, WebSocket)");
console.log("  • Web servers (SSR Website, Admin Dashboard)");
console.log("  • Infrastructure (Message Queue, Monitoring & Metrics)");
console.log("  • Tab scrolling with arrow buttons for many services");
console.log("  • Text truncation for long service names");
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
