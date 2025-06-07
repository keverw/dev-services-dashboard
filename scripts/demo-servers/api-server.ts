/**
 * Demo API Server
 * Simulates a REST API server with realistic HTTP request logging
 */

import { getRandomElement, generateIpAddress } from "./demo-utils";

console.log("🚀 Starting API server...");
console.log("📍 Server listening on http://localhost:3001");
console.log("🔧 Environment: development");
console.log("✅ API server ready to handle requests");

const endpoints = [
  "GET /api/users",
  "POST /api/users",
  "GET /api/users/:id",
  "PUT /api/users/:id",
  "DELETE /api/users/:id",
  "GET /api/products",
  "POST /api/products",
  "GET /api/products/:id",
  "GET /api/orders",
  "POST /api/orders",
  "GET /api/orders/:id",
  "PUT /api/orders/:id/status",
  "GET /api/auth/me",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/health",
];

const statusCodes = [
  { code: 200, weight: 70 },
  { code: 201, weight: 10 },
  { code: 400, weight: 8 },
  { code: 401, weight: 5 },
  { code: 404, weight: 4 },
  { code: 500, weight: 3 },
];

const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "PostmanRuntime/7.32.3",
  "curl/8.1.2",
  "axios/1.5.0",
];

function getWeightedStatusCode(): number {
  const totalWeight = statusCodes.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (const item of statusCodes) {
    random -= item.weight;
    if (random <= 0) {
      return item.code;
    }
  }

  return 200; // fallback
}

function simulateApiRequest() {
  const endpoint = getRandomElement(endpoints);
  const statusCode = getWeightedStatusCode();
  const responseTime = Math.floor(Math.random() * 500 + 10); // 10-510ms
  const ip = generateIpAddress();
  const userAgent = getRandomElement(userAgents);
  const requestId = Math.random().toString(36).substring(2, 15);

  // Log the request
  console.log(
    `[INFO] [${requestId}] ${endpoint} - ${ip} - "${userAgent.substring(0, 50)}..."`,
  );

  // Log any errors
  if (statusCode >= 400) {
    const errorMessages = {
      400: "Bad Request: Invalid request parameters",
      401: "Unauthorized: Invalid or missing authentication token",
      404: "Not Found: Resource does not exist",
      500: "Internal Server Error: Database connection failed",
    };

    console.error(
      `[ERROR] [${requestId}] ${errorMessages[statusCode as keyof typeof errorMessages] || "Unknown error"}`,
    );
  }

  // Log the response
  console.log(
    `[INFO] [${requestId}] Response: ${statusCode} - ${responseTime}ms`,
  );
}

function simulateSystemActivity() {
  const activities = [
    "[INFO] [system] Health check passed - all dependencies healthy",
    "[INFO] [system] Cache cleared for expired sessions",
    "[DEBUG] [system] Memory usage: 45.2MB / 512MB",
    "[INFO] [system] Rate limiter reset for IP pool",
    "[WARN] [system] High memory usage detected (>80%)",
    "[INFO] [system] Background job queue processed 15 items",
    "[DEBUG] [system] Database connection pool: 8/20 connections active",
  ];

  console.log(getRandomElement(activities));
}

function simulateMiddlewareActivity() {
  const activities = [
    "[DEBUG] [auth] JWT token validated successfully",
    "[DEBUG] [cors] CORS headers added for origin: http://localhost:3000",
    "[INFO] [rate-limit] Rate limit applied: 100 requests/hour",
    "[WARN] [auth] Failed login attempt from 192.168.1.45",
    "[DEBUG] [validation] Request body validation passed",
    "[INFO] [cache] Cache hit for key: user_profile_123",
    "[DEBUG] [cache] Cache miss for key: product_list_electronics",
  ];

  console.log(getRandomElement(activities));
}

// Simulate API activity
setInterval(simulateApiRequest, 1000 + Math.random() * 2000); // Every 1-3 seconds
setInterval(simulateSystemActivity, 8000 + Math.random() * 12000); // Every 8-20 seconds
setInterval(simulateMiddlewareActivity, 3000 + Math.random() * 5000); // Every 3-8 seconds

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down API server gracefully...");
  console.log("🔄 Finishing pending requests...");
  console.log("🔒 Closing database connections...");
  console.log("✅ API server shutdown complete");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, shutting down API server gracefully...");
  console.log("🔄 Finishing pending requests...");
  console.log("🔒 Closing database connections...");
  console.log("✅ API server shutdown complete");
  process.exit(0);
});
