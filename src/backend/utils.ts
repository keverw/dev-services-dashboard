export function logMessage(
  level: "info" | "error" | "warn",
  message: string,
  data?: object,
) {
  const timestamp = new Date().toISOString();
  console[level](
    `[${timestamp}] [DevUI ${level.toUpperCase()}] ${message}`,
    data || "",
  );
}
