import { getRandomElement } from "./demo-utils";

/**
 * Demo Database Server
 * Simulates a PostgreSQL database server with realistic logging
 */

console.log("🗄️  Starting PostgreSQL database server...");
console.log("📍 Listening on localhost:5432");
console.log("✅ Database server ready to accept connections");

const dbOperations = [
  "SELECT * FROM users WHERE active = true",
  "INSERT INTO sessions (user_id, token) VALUES ($1, $2)",
  "UPDATE users SET last_login = NOW() WHERE id = $1",
  "DELETE FROM expired_tokens WHERE created_at < NOW() - INTERVAL '1 hour'",
  "SELECT COUNT(*) FROM orders WHERE status = 'pending'",
  "CREATE INDEX CONCURRENTLY idx_users_email ON users(email)",
  "VACUUM ANALYZE users",
  "SELECT * FROM products WHERE category = 'electronics' LIMIT 10",
];

const logLevels = ["INFO", "DEBUG", "WARN"];
const connectionIds = Array.from({ length: 5 }, (_, i) => `conn_${i + 1}`);

function simulateDbActivity() {
  const operation = getRandomElement(dbOperations);
  const level = getRandomElement(logLevels);
  const connId = getRandomElement(connectionIds);
  const duration = (Math.random() * 50 + 1).toFixed(2);

  console.log(
    `[${level}] [${connId}] Query executed in ${duration}ms: ${operation}`,
  );
}

function simulateConnectionActivity() {
  const connId = getRandomElement(connectionIds);
  const activities = [
    `[INFO] [${connId}] New connection established from 127.0.0.1:${Math.floor(Math.random() * 10000 + 50000)}`,
    `[INFO] [${connId}] Connection closed gracefully`,
    `[DEBUG] [${connId}] Heartbeat received`,
    `[WARN] [${connId}] Slow query detected (>100ms)`,
  ];

  console.log(getRandomElement(activities));
}

function simulateMaintenanceActivity() {
  const activities = [
    "[INFO] [maintenance] Auto-vacuum started on table 'users'",
    "[INFO] [maintenance] Statistics updated for table 'products'",
    "[DEBUG] [maintenance] Checkpoint completed",
    "[INFO] [maintenance] Log file rotated",
  ];

  console.log(getRandomElement(activities));
}

// Simulate database activity
setInterval(simulateDbActivity, 2000 + Math.random() * 3000); // Every 2-5 seconds
setInterval(simulateConnectionActivity, 5000 + Math.random() * 10000); // Every 5-15 seconds
setInterval(simulateMaintenanceActivity, 15000 + Math.random() * 30000); // Every 15-45 seconds

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log(
    "🛑 Received SIGTERM, shutting down database server gracefully...",
  );
  console.log("💾 Flushing pending writes to disk...");
  console.log("🔒 Closing all connections...");
  console.log("✅ Database server shutdown complete");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(
    "\n🛑 Received SIGINT, shutting down database server gracefully...",
  );
  console.log("💾 Flushing pending writes to disk...");
  console.log("🔒 Closing all connections...");
  console.log("✅ Database server shutdown complete");
  process.exit(0);
});
