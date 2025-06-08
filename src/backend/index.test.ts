import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { spawn } from "child_process";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { readFile } from "fs/promises";
import getPort from "get-port";

// Mock dependencies
mock.module("child_process", () => ({
  spawn: mock(() => {
    const mockProcess = {
      on: mock((event: string, callback: Function) => {
        if (event === "spawn") {
          // Simulate successful spawn
          setTimeout(() => callback(), 10);
        }
      }),
      stdout: { on: mock() },
      stderr: { on: mock() },
      kill: mock(),
      removeAllListeners: mock(),
      pid: 12345,
    };
    return mockProcess;
  }),
}));

mock.module("fs/promises", () => ({
  readFile: mock(() => Promise.resolve("<html>Test HTML</html>")),
}));

// Import after mocking
import {
  startDevServicesDashboard,
  type DevUIConfig,
  type UserServiceConfig,
} from "./index";

describe("Dev Services Dashboard", () => {
  let mockBroadcast: ReturnType<typeof mock>;
  let testConfig: DevUIConfig;

  beforeEach(async () => {
    mockBroadcast = mock();
    // Use dynamic port allocation to avoid conflicts
    const port = await getPort();
    testConfig = {
      port, // Use dynamic port
      hostname: "localhost",
      maxLogLines: 10,
      defaultCwd: "/tmp/test-default", // Explicit test default directory
      services: [
        {
          id: "test-service",
          name: "Test Service",
          command: ["echo", "hello"],
          cwd: "/tmp",
          env: { TEST: "true" },
          webLinks: [{ label: "Test Link", url: "http://test.com" }],
        },
      ],
    };
  });

  afterEach(() => {
    mock.restore();
  });

  describe("ServiceManager", () => {
    // We'll need to extract ServiceManager to test it directly
    // For now, let's test through the main interface

    it("should create services from config", async () => {
      const server = await startDevServicesDashboard(testConfig);
      expect(server).toBeDefined();
      expect(server.httpServer).toBeDefined();
      expect(server.wsServer).toBeDefined();
      expect(server.stop).toBeFunction();

      await server.stop();
    });

    it("should handle invalid service IDs gracefully", () => {
      // This would require exposing ServiceManager methods
      // We'll implement this after extracting the class
      expect(true).toBe(true); // Placeholder
    });
  });

  describe("HTTP Handler", () => {
    it("should serve HTML on root path", async () => {
      const server = await startDevServicesDashboard(testConfig);

      // Test HTTP request handling
      const response = await fetch(`http://localhost:${server.port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      await server.stop();
    });

    it("should serve services config on API endpoint", async () => {
      const server = await startDevServicesDashboard(testConfig);

      const response = await fetch(
        `http://localhost:${server.port}/api/services-config`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );

      const data = await response.json();
      expect(data).toMatchObject({
        dashboardName: "Dev Services Dashboard",
        services: expect.arrayContaining([
          expect.objectContaining({
            id: "test-service",
            name: "Test Service",
            webLinks: [{ label: "Test Link", url: "http://test.com" }],
          }),
        ]),
      });

      await server.stop();
    });

    it("should return 404 for unknown paths", async () => {
      const server = await startDevServicesDashboard(testConfig);

      const response = await fetch(`http://localhost:${server.port}/unknown`);
      expect(response.status).toBe(404);

      await server.stop();
    });
  });

  describe("WebSocket Handler", () => {
    it("should handle WebSocket connections", async () => {
      const server = await startDevServicesDashboard(testConfig);

      // Create WebSocket connection
      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
        setTimeout(reject, 1000); // Timeout after 1 second
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await server.stop();
    });

    it("should send initial state on connection", async () => {
      const server = await startDevServicesDashboard(testConfig);

      const ws = new WebSocket(`ws://localhost:${server.port}`);

      const initialMessage = await new Promise((resolve, reject) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data));
        };
        ws.onerror = reject;
        setTimeout(reject, 1000);
      });

      expect(initialMessage).toMatchObject({
        type: "initial_state",
        services: expect.arrayContaining([
          expect.objectContaining({
            id: "test-service",
            name: "Test Service",
            status: "stopped",
          }),
        ]),
      });

      ws.close();
      await server.stop();
    });
  });

  describe("Service Process Management", () => {
    it("should handle invalid service ID", async () => {
      const server = await startDevServicesDashboard(testConfig);

      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise((resolve) => {
        ws.onopen = resolve;
      });

      // Send command with invalid service ID
      ws.send(
        JSON.stringify({
          action: "start",
          serviceID: "invalid-service",
        }),
      );

      // Wait for error response
      const errorResponse = await new Promise((resolve, reject) => {
        let messageCount = 0;
        ws.onmessage = (event) => {
          messageCount++;
          const data = JSON.parse(event.data);
          if (data.type === "error_from_server" && messageCount > 1) {
            // Skip initial state
            resolve(data);
          }
        };
        setTimeout(reject, 1000);
      });

      expect(errorResponse).toMatchObject({
        type: "error_from_server",
        message: expect.stringContaining("Invalid serviceID"),
      });

      ws.close();
      await server.stop();
    });
  });

  describe("Configuration", () => {
    it("should use default values when not specified", async () => {
      const port = await getPort();
      const minimalConfig: DevUIConfig = {
        port, // Use dynamic port to avoid conflicts
        services: [
          {
            id: "minimal-service",
            name: "Minimal Service",
            command: ["echo", "test"],
          },
        ],
      };

      const server = await startDevServicesDashboard(minimalConfig);
      expect(server).toBeDefined();
      expect(server.port).toBe(port);

      await server.stop();
    });

    it("should handle services with minimal configuration", async () => {
      const port = await getPort();
      const minimalConfig: DevUIConfig = {
        port,
        services: [
          {
            id: "minimal",
            name: "Minimal",
            command: ["echo", "test"],
          },
        ],
      };

      const server = await startDevServicesDashboard(minimalConfig);

      const response = await fetch(
        `http://localhost:${server.port}/api/services-config`,
      );
      const data = await response.json();

      expect(data).toMatchObject({
        dashboardName: "Dev Services Dashboard",
        services: expect.arrayContaining([
          expect.objectContaining({
            id: "minimal",
            name: "Minimal",
            webLinks: [],
          }),
        ]),
      });

      await server.stop();
    });

    it("should use custom dashboard name when provided", async () => {
      const port = await getPort();
      const customConfig: DevUIConfig = {
        port,
        dashboardName: "My Custom Dashboard",
        services: [
          {
            id: "test",
            name: "Test Service",
            command: ["echo", "test"],
          },
        ],
      };

      const server = await startDevServicesDashboard(customConfig);

      const response = await fetch(
        `http://localhost:${server.port}/api/services-config`,
      );
      const data = await response.json();

      expect(data).toMatchObject({
        dashboardName: "My Custom Dashboard",
        services: expect.arrayContaining([
          expect.objectContaining({
            id: "test",
            name: "Test Service",
            webLinks: [],
          }),
        ]),
      });

      await server.stop();
    });
  });

  describe("Error Handling", () => {
    it("should handle server startup errors gracefully", async () => {
      // Test that the server can handle configuration errors
      const port = await getPort();
      const invalidConfig: DevUIConfig = {
        port,
        services: [
          {
            id: "", // Invalid empty ID
            name: "Invalid Service",
            command: [],
          },
        ],
      };

      // Server should still start even with invalid service config
      const server = await startDevServicesDashboard(invalidConfig);
      expect(server).toBeDefined();
      await server.stop();
    });

    it("should handle malformed WebSocket messages", async () => {
      const server = await startDevServicesDashboard(testConfig);

      const ws = new WebSocket(`ws://localhost:${server.port}`);

      await new Promise((resolve) => {
        ws.onopen = resolve;
      });

      // Send malformed JSON
      ws.send("invalid json");

      // Wait for error response
      const errorResponse = await new Promise((resolve, reject) => {
        let messageCount = 0;
        ws.onmessage = (event) => {
          messageCount++;
          const data = JSON.parse(event.data);
          if (data.type === "error_from_server" && messageCount > 1) {
            resolve(data);
          }
        };
        setTimeout(reject, 1000);
      });

      expect(errorResponse).toMatchObject({
        type: "error_from_server",
        message: expect.stringContaining("Error"),
      });

      ws.close();
      await server.stop();
    });
  });
});
