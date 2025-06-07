import { getRandomElement, generateIpAddress } from "./demo-utils";

/**
 * Demo SSR Server
 * Simulates a Server-Side Rendering application (like Next.js) with realistic logging
 */

console.log("⚡ Starting SSR server...");
console.log("📍 Server listening on http://localhost:3000");
console.log("🔧 Environment: development");
console.log("🎨 Hot reload enabled");
console.log("✅ SSR server ready to serve pages");

const pages = [
  "/",
  "/about",
  "/products",
  "/products/[id]",
  "/users/profile",
  "/dashboard",
  "/login",
  "/signup",
  "/contact",
  "/blog",
  "/blog/[slug]",
  "/api/auth/[...nextauth]",
];

const staticAssets = [
  "/favicon.ico",
  "/_next/static/css/app.css",
  "/_next/static/js/app.js",
  "/_next/static/js/webpack.js",
  "/_next/static/chunks/main.js",
  "/_next/static/chunks/pages/_app.js",
  "/_next/static/media/logo.svg",
  "/images/hero-banner.jpg",
  "/images/product-1.jpg",
];

function simulatePageRequest() {
  const page = getRandomElement(pages);
  const ip = generateIpAddress();
  const renderTime = Math.floor(Math.random() * 200 + 50); // 50-250ms
  const requestId = Math.random().toString(36).substring(2, 15);

  console.log(`[INFO] [${requestId}] SSR request: ${page} from ${ip}`);

  // Simulate component rendering
  if (page.includes("[")) {
    console.log(
      `[DEBUG] [${requestId}] Dynamic route detected, fetching data...`,
    );
    console.log(
      `[DEBUG] [${requestId}] Data fetched in ${Math.floor(Math.random() * 50 + 10)}ms`,
    );
  }

  console.log(`[DEBUG] [${requestId}] Rendering React components...`);
  console.log(`[INFO] [${requestId}] Page rendered in ${renderTime}ms - 200`);
}

function simulateStaticAssetRequest() {
  const asset = getRandomElement(staticAssets);
  const ip = generateIpAddress();
  const requestId = Math.random().toString(36).substring(2, 15);
  const cacheStatus = Math.random() > 0.3 ? "HIT" : "MISS";

  console.log(
    `[DEBUG] [${requestId}] Static asset: ${asset} from ${ip} - Cache: ${cacheStatus}`,
  );
}

function simulateHotReload() {
  const files = [
    "src/components/Header.tsx",
    "src/pages/index.tsx",
    "src/styles/globals.css",
    "src/components/ProductCard.tsx",
    "src/utils/api.ts",
    "src/hooks/useAuth.ts",
  ];

  const file = getRandomElement(files);
  console.log(`[INFO] [hot-reload] File changed: ${file}`);
  console.log(`[INFO] [hot-reload] Recompiling...`);

  setTimeout(() => {
    console.log(
      `[INFO] [hot-reload] ✅ Compilation successful - ready in ${Math.floor(Math.random() * 1000 + 500)}ms`,
    );
  }, 100);
}

function simulateBuildActivity() {
  const activities = [
    "[INFO] [build] Optimizing bundle size...",
    "[DEBUG] [build] Tree-shaking unused code",
    "[INFO] [build] Generating static pages...",
    "[DEBUG] [build] Code splitting completed",
    "[INFO] [build] Image optimization completed",
    "[WARN] [build] Large bundle detected (>500KB)",
    "[DEBUG] [build] Source maps generated",
  ];

  console.log(getRandomElement(activities));
}

function simulateApiRouteActivity() {
  const apiRoutes = [
    "/api/auth/session",
    "/api/users/me",
    "/api/products",
    "/api/orders",
    "/api/health",
  ];

  const route = getRandomElement(apiRoutes);
  const ip = generateIpAddress();
  const responseTime = Math.floor(Math.random() * 100 + 20);
  const requestId = Math.random().toString(36).substring(2, 15);

  console.log(
    `[INFO] [${requestId}] API route: ${route} from ${ip} - ${responseTime}ms`,
  );
}

function simulateErrorScenario() {
  const errors = [
    "[ERROR] [render] Hydration mismatch detected on page /products",
    "[WARN] [performance] Slow component render detected: ProductList (>100ms)",
    "[ERROR] [api] Failed to fetch data from external API: timeout",
    "[WARN] [memory] High memory usage detected during SSR",
    "[ERROR] [build] TypeScript compilation error in src/types/user.ts",
  ];

  // Only show errors occasionally
  if (Math.random() < 0.1) {
    // 10% chance
    console.error(getRandomElement(errors));
  }
}

// Simulate SSR activity
setInterval(simulatePageRequest, 2000 + Math.random() * 4000); // Every 2-6 seconds
setInterval(simulateStaticAssetRequest, 500 + Math.random() * 1500); // Every 0.5-2 seconds
setInterval(simulateHotReload, 15000 + Math.random() * 30000); // Every 15-45 seconds
setInterval(simulateBuildActivity, 10000 + Math.random() * 20000); // Every 10-30 seconds
setInterval(simulateApiRouteActivity, 3000 + Math.random() * 5000); // Every 3-8 seconds
setInterval(simulateErrorScenario, 8000 + Math.random() * 15000); // Every 8-23 seconds

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down SSR server gracefully...");
  console.log("🔄 Finishing pending requests...");
  console.log("💾 Saving build cache...");
  console.log("✅ SSR server shutdown complete");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, shutting down SSR server gracefully...");
  console.log("🔄 Finishing pending requests...");
  console.log("💾 Saving build cache...");
  console.log("✅ SSR server shutdown complete");
  process.exit(0);
});
