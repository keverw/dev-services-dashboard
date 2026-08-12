/**
 * Demo Stubborn Server
 *
 * Deliberately ignores SIGTERM and keeps running. Every other demo server
 * exits on the first SIGTERM, so a normal stop completes almost instantly and
 * the `stopping` state flashes past. This one wedges there for the whole grace
 * period, which is what makes the escalation affordances demoable: the Stop
 * button becoming a pulsing "Force Stop", the header's "Force Stop All", and
 * `dsd stop stubborn --force` / `--grace <ms>`.
 *
 * Only SIGKILL ends it, which is exactly what a force stop sends.
 */

console.log("🐢 Starting stubborn server...");
console.log(
  "⚠️  This service ignores SIGTERM on purpose. Only SIGKILL ends it.",
);

let ticks = 0;

setInterval(() => {
  ticks += 1;
  console.log(`[INFO] Still here after ${ticks * 2}s of doing very little`);
}, 2000);

// Trap SIGTERM and refuse to act on it. Trapping rather than ignoring means the
// logs show the stop request arriving, so it's clear the dashboard did ask
// politely first and the service is the one being difficult.
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM. Ignoring it. Try Force Stop.");
});

// SIGINT too, so running this file by hand behaves the same way (Ctrl+\ or a
// kill -9 from another terminal ends it).
process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT. Ignoring it. Try Force Stop.");
});
