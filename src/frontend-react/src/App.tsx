import { useState, useEffect } from "react";
import { ServiceConfig, WebSocketMessage, AutoScrollStates } from "./types";
import Header from "./components/Header";
import TabNavigation from "./components/TabNavigation";
import ServiceTab from "./components/ServiceTab";
import { useWebSocket } from "./hooks/useWebSocket";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";

const MAX_CLIENT_LOGS = 500;

function App() {
  const [activeServicesConfig, setActiveServicesConfig] = useState<
    ServiceConfig[]
  >([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [startAllInProgress, setStartAllInProgress] = useState(false);
  const [autoScrollStates, setAutoScrollStates] = useState<AutoScrollStates>(
    {},
  );
  const [serviceLogs, setServiceLogs] = useState<{
    [serviceId: string]: string;
  }>({});
  const [serviceStatuses, setServiceStatuses] = useState<{
    [serviceId: string]: { status: string; errorDetails?: string };
  }>({});
  const [connectionStatuses, setConnectionStatuses] = useState<{
    [serviceId: string]: { status: string; message: string };
  }>({});
  const [startAllStatus, setStartAllStatus] = useState<{
    message: string;
    color?: string;
  }>({ message: "" });

  const { socket, sendAction } = useWebSocket({
    onMessage: handleWebSocketMessage,
    onOpen: handleWebSocketOpen,
    onClose: handleWebSocketClose,
    onError: handleWebSocketError,
  });

  // Add keyboard navigation for tabs
  useKeyboardNavigation({
    services: activeServicesConfig,
    activeTabId,
    onTabSwitch: switchTab,
  });

  // Load services configuration on mount
  useEffect(() => {
    fetch("/api/services-config")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then((fetchedServicesConfig: ServiceConfig[]) => {
        setActiveServicesConfig(fetchedServicesConfig);

        // Initialize auto-scroll states
        const initialAutoScrollStates: AutoScrollStates = {};
        fetchedServicesConfig.forEach((service) => {
          initialAutoScrollStates[service.id] = true;
        });
        setAutoScrollStates(initialAutoScrollStates);

        // Set first tab as active
        if (fetchedServicesConfig.length > 0 && !activeTabId) {
          setActiveTabId(fetchedServicesConfig[0].id);
        }
      })
      .catch((error) => {
        console.error("Error fetching services config:", error);
      });
  }, [activeTabId]);

  function handleWebSocketMessage(data: WebSocketMessage) {
    switch (data.type) {
      case "initial_state":
        if (data.services) {
          data.services.forEach((s) => {
            updateServiceStatus(s.id, s.status, s.errorDetails);
            updateConnectionStatus(s.id, "connected", "Connected");

            // Clear and populate logs
            const logsText = s.logs
              .map((log) => {
                const ts = new Date(log.timestamp).toLocaleTimeString();
                return `[${ts}] ${log.line}`;
              })
              .join("\n");

            setServiceLogs((prev) => ({ ...prev, [s.id]: logsText }));
          });
        }
        break;
      case "log":
        if (data.serviceID && data.line && data.timestamp) {
          addLogMessage(
            data.serviceID,
            data.line,
            data.logType || "stdout",
            data.timestamp,
          );
        }
        break;
      case "status_update":
        if (data.serviceID && data.status) {
          updateServiceStatus(data.serviceID, data.status, data.errorDetails);
        }
        break;
      case "logs_cleared":
        if (data.serviceID) {
          setServiceLogs((prev) => ({ ...prev, [data.serviceID!]: "" }));
          addLogMessage(
            data.serviceID,
            "Log buffer cleared by user.",
            "system",
            Date.now(),
          );
        }
        break;
      case "error_from_server":
        if (data.message) {
          alert(`Server error: ${data.message}`);
        }
        break;
    }
  }

  function handleWebSocketOpen() {
    activeServicesConfig.forEach((service) => {
      updateConnectionStatus(service.id, "connected", "Connected");
    });
  }

  function handleWebSocketClose() {
    activeServicesConfig.forEach((service) => {
      updateServiceStatus(service.id, "stopped", "Disconnected");
      updateConnectionStatus(
        service.id,
        "disconnected",
        "Disconnected. Retrying...",
      );
    });
  }

  function handleWebSocketError() {
    activeServicesConfig.forEach((service) => {
      updateConnectionStatus(service.id, "disconnected", "Connection error");
    });
  }

  function updateServiceStatus(
    serviceID: string,
    status: string,
    errorDetails?: string,
  ) {
    setServiceStatuses((prev) => ({
      ...prev,
      [serviceID]: { status, errorDetails },
    }));
  }

  function updateConnectionStatus(
    serviceID: string,
    status: string,
    message: string,
  ) {
    setConnectionStatuses((prev) => ({
      ...prev,
      [serviceID]: { status, message },
    }));
  }

  function addLogMessage(
    serviceID: string,
    line: string,
    _logType: string,
    timestamp: number,
  ) {
    const ts = new Date(timestamp).toLocaleTimeString();
    const logLine = `[${ts}] ${line}`;

    setServiceLogs((prev) => {
      const currentLogs = prev[serviceID] || "";
      const lines = currentLogs.split("\n").filter((l) => l.length > 0);
      lines.push(logLine);

      // Keep only MAX_CLIENT_LOGS lines
      while (lines.length > MAX_CLIENT_LOGS) {
        lines.shift();
      }

      return { ...prev, [serviceID]: lines.join("\n") };
    });
  }

  function switchTab(serviceID: string) {
    setActiveTabId(serviceID);
  }

  function toggleAutoScroll(serviceID: string) {
    setAutoScrollStates((prev) => ({
      ...prev,
      [serviceID]: !prev[serviceID],
    }));
  }

  function clearLogs(serviceID: string) {
    setServiceLogs((prev) => ({ ...prev, [serviceID]: "" }));
    addLogMessage(
      serviceID,
      "Log buffer cleared by user.",
      "system",
      Date.now(),
    );
    sendAction(serviceID, "clear_logs");
  }

  function startAllServices() {
    if (startAllInProgress) return;

    // Reset all state variables to ensure a fresh start
    setStartAllInProgress(false); // Reset first to avoid race conditions

    // Clear any existing timeouts
    const statusKey = "start-all-status";
    // Note: In React we don't need statusMessageTimeouts Map, we use state cleanup

    // Check if we're connected to the server
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStartAllStatus({
        message: "Cannot start services: Not connected to server",
        color: "#e74c3c",
      });

      // Clear the error message after a few seconds
      setTimeout(() => {
        setStartAllStatus({ message: "", color: "" });
      }, 5000);
      return;
    }

    setStartAllInProgress(true);
    setStartAllStatus({ message: "Starting services...", color: "" });

    let currentIndex = 0;
    let startedCount = 0;
    let failedCount = 0;
    let abortStartAll = false;

    // Create a map to track service status changes
    const serviceStartPromises = new Map();
    const serviceStartTimeouts = new Map();

    function startNextService() {
      if (currentIndex >= activeServicesConfig.length || abortStartAll) {
        // All services processed or abort triggered
        finishStartAll();
        return;
      }

      const service = activeServicesConfig[currentIndex];
      const currentStatus = serviceStatuses[service.id]?.status || "stopped";

      // Skip if already running or starting
      if (currentStatus === "running" || currentStatus === "starting") {
        currentIndex++;
        startedCount++; // Count as started since it's already running
        startNextService();
        return;
      }

      // Check connection status for this service
      const connectionStatus = connectionStatuses[service.id];
      if (connectionStatus && connectionStatus.message !== "Connected") {
        // Service is not connected, count as failed
        failedCount++;
        currentIndex++;
        startNextService();
        return;
      }

      setStartAllStatus({
        message: `Starting ${service.name}... (${currentIndex + 1}/${activeServicesConfig.length})`,
        color: "",
      });

      // Create a promise that resolves when the service starts or fails
      const startPromise = new Promise((resolve) => {
        // Set up a listener for status changes
        const statusChangeListener = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (
              data.type === "status_update" &&
              data.serviceID === service.id
            ) {
              if (data.status === "running") {
                // Service started successfully
                resolve({ success: true });
              } else if (data.status === "error" || data.status === "crashed") {
                // Service failed to start
                resolve({
                  success: false,
                  errorDetails: data.errorDetails || "Failed to start",
                });
              }
            }
          } catch (err) {
            console.error("Error parsing WebSocket message:", err);
          }
        };

        // Add the listener
        if (socket) {
          socket.addEventListener("message", statusChangeListener);

          // Store the listener so we can remove it later
          serviceStartPromises.set(service.id, {
            resolve,
            listener: statusChangeListener,
          });

          // Set a timeout to abort waiting after 10 seconds
          const timeout = setTimeout(() => {
            if (serviceStartPromises.has(service.id)) {
              resolve({
                success: false,
                errorDetails: "Timed out waiting for service to start",
              });
            }
          }, 10000);

          serviceStartTimeouts.set(service.id, timeout);
        }
      });

      // Send start command
      sendAction(service.id, "start");

      // Wait for the service to start or fail
      startPromise.then((result: any) => {
        // Clean up listeners and timeouts
        const serviceData = serviceStartPromises.get(service.id);
        if (serviceData && socket) {
          socket.removeEventListener("message", serviceData.listener);
          serviceStartPromises.delete(service.id);
        }

        const timeout = serviceStartTimeouts.get(service.id);
        if (timeout) {
          clearTimeout(timeout);
          serviceStartTimeouts.delete(service.id);
        }

        if (result.success) {
          // Service started successfully
          startedCount++;
          currentIndex++;
          startNextService();
        } else {
          // Service failed to start
          failedCount++;
          abortStartAll = true; // Abort starting any more services

          // Show error in status
          setStartAllStatus({
            message: `Failed to start ${service.name}: ${result.errorDetails}`,
            color: "#e74c3c",
          });

          // Finish the start all process
          finishStartAll();
        }
      });
    }

    function finishStartAll() {
      // Clean up any remaining listeners and timeouts
      for (const [serviceID, serviceData] of serviceStartPromises.entries()) {
        if (socket) {
          socket.removeEventListener("message", serviceData.listener);
        }
      }
      serviceStartPromises.clear();

      for (const timeout of serviceStartTimeouts.values()) {
        clearTimeout(timeout);
      }
      serviceStartTimeouts.clear();

      // Update UI
      setStartAllInProgress(false);

      if (abortStartAll) {
        // We already set the error message when aborting
        // Just ensure it stays visible longer
        setTimeout(() => {
          setStartAllStatus({ message: "", color: "" });
        }, 8000);
      } else if (failedCount > 0) {
        setStartAllStatus({
          message: `${startedCount} services started, ${failedCount} failed`,
          color: "#e67e22", // Orange for warning
        });
        setTimeout(() => {
          setStartAllStatus({ message: "", color: "" });
        }, 5000);
      } else {
        setStartAllStatus({
          message: "All services started!",
          color: "#2ecc71", // Green for success
        });
        setTimeout(() => {
          setStartAllStatus({ message: "", color: "" });
        }, 5000);
      }
    }

    startNextService();
  }

  return (
    <>
      <Header />
      <TabNavigation
        services={activeServicesConfig}
        activeTabId={activeTabId}
        onTabSwitch={switchTab}
        onStartAll={startAllServices}
        startAllInProgress={startAllInProgress}
        startAllStatus={startAllStatus}
        serviceStatuses={serviceStatuses}
      />
      <div className="main-content">
        <div className="tab-content-container">
          {activeServicesConfig.map((service) => (
            <ServiceTab
              key={service.id}
              service={service}
              isActive={activeTabId === service.id}
              status={serviceStatuses[service.id]}
              connectionStatus={connectionStatuses[service.id]}
              logs={serviceLogs[service.id] || ""}
              autoScroll={autoScrollStates[service.id] || false}
              onStart={() => sendAction(service.id, "start")}
              onStop={() => sendAction(service.id, "stop")}
              onRestart={() => sendAction(service.id, "restart")}
              onClearLogs={() => clearLogs(service.id)}
              onToggleAutoScroll={() => toggleAutoScroll(service.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

export default App;
