import { useState, useEffect, useRef } from "react";
import {
  ServiceConfig,
  WebSocketMessage,
  AutoScrollStates,
  ServicesConfigResponse,
} from "./types";
import Header from "./components/Header";
import TabNavigation from "./components/TabNavigation";
import ServiceTab from "./components/ServiceTab";
import ToastContainer from "./components/ToastContainer";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { useWebSocket } from "./hooks/useWebSocket";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";

const MAX_CLIENT_LOGS = 500;

function AppContent() {
  const { addToast, updateToast, removeToast } = useToast();
  const [activeServicesConfig, setActiveServicesConfig] = useState<
    ServiceConfig[]
  >([]);
  const [dashboardName, setDashboardName] = useState<string>(
    "Dev Services Dashboard",
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startAllInProgress, setStartAllInProgress] = useState(false);
  // The WebSocket message handler is bound once on mount, so it would close
  // over a stale `startAllInProgress`. A ref gives it the always-current value
  // for suppressing per-service toasts during "Start All".
  const startAllInProgressRef = useRef(false);
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

  const { socket, sendAction, sendGlobalAction } = useWebSocket({
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
    const MIN_LOADING_TIME = 750; // Minimum loading time in ms

    const loadServices = async () => {
      const startTime = Date.now();

      try {
        const response = await fetch("/api/services-config");
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const configResponse: ServicesConfigResponse = await response.json();

        // Calculate remaining time to meet minimum loading duration
        const elapsedTime = Date.now() - startTime;
        const remainingTime = Math.max(0, MIN_LOADING_TIME - elapsedTime);

        // Wait for remaining time if needed
        if (remainingTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingTime));
        }

        setActiveServicesConfig(configResponse.services);
        setDashboardName(configResponse.dashboardName);
        setLoadError(null); // Clear any previous error

        // Initialize auto-scroll states
        const initialAutoScrollStates: AutoScrollStates = {};
        configResponse.services.forEach((service) => {
          initialAutoScrollStates[service.id] = true;
        });

        setAutoScrollStates(initialAutoScrollStates);

        // Set first tab as active (this effect only runs once on mount, so
        // activeTabId is always unset here).
        if (configResponse.services.length > 0) {
          setActiveTabId(configResponse.services[0].id);
        }

        setIsLoading(false);
      } catch (error) {
        // Calculate remaining time to meet minimum loading duration
        const elapsedTime = Date.now() - startTime;
        const remainingTime = Math.max(0, MIN_LOADING_TIME - elapsedTime);

        // Wait for remaining time if needed
        if (remainingTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingTime));
        }

        console.error("Error fetching services config:", error);
        setLoadError(error.message || "Failed to load services");
        setIsLoading(false);
      }
    };

    // Start loading immediately
    loadServices();
  }, []); // only load once on mount the services config

  // Update document title when dashboard name changes
  useEffect(() => {
    document.title = dashboardName;
  }, [dashboardName]);

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

          // Add toast notifications for individual service status changes
          // (but only if not during "Start All" to avoid duplicate toasts)
          if (!startAllInProgressRef.current) {
            const service = activeServicesConfig.find(
              (s) => s.id === data.serviceID,
            );
            const serviceName = service?.name || data.serviceID;

            if (data.status === "running") {
              addToast({
                message: `${serviceName} started successfully!`,
                type: "success",
                duration: 3000, // Increased to match others
              });
            } else if (data.status === "stopped") {
              addToast({
                message: `${serviceName} stopped`,
                type: "info",
                duration: 3000, // Increased to match others
              });
            } else if (data.status === "error" || data.status === "crashed") {
              addToast({
                message: `${serviceName} ${data.status}: ${data.errorDetails || "Unknown error"}`,
                type: "error",
                duration: 5000, // Keep longer for errors
              });
            }
          }
        }
        break;
      case "links_update":
        if (data.serviceID && data.webLinks) {
          const updatedLinks = data.webLinks;
          setActiveServicesConfig((prev) =>
            prev.map((s) =>
              s.id === data.serviceID ? { ...s, webLinks: updatedLinks } : s,
            ),
          );
        }
        break;
      case "logs_cleared":
        if (data.serviceID) {
          setServiceLogs((prev) => ({ ...prev, [data.serviceID!]: "" }));
          // eslint-disable-next-line react-hooks/purity -- runs in a WebSocket message handler, not during render
          const clearedAt = Date.now();

          addLogMessage(
            data.serviceID,
            "Log buffer cleared by user.",
            "system",
            clearedAt,
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
    setAutoScrollStates((prev) => {
      const currentState =
        prev[serviceID] !== undefined ? prev[serviceID] : true;
      return {
        ...prev,
        [serviceID]: !currentState,
      };
    });
  }

  function clearLogs(serviceID: string) {
    setServiceLogs((prev) => ({ ...prev, [serviceID]: "" }));
    // eslint-disable-next-line react-hooks/purity -- runs in a click handler, not during render
    const clearedAt = Date.now();
    addLogMessage(
      serviceID,
      "Log buffer cleared by user.",
      "system",
      clearedAt,
    );
    sendAction(serviceID, "clear_logs");
  }

  function startAllServices() {
    if (startAllInProgress) {
      // For testing: allow multiple clicks to create multiple toasts
      addToast({
        message: "Start All is already in progress...",
        type: "warning",
      });
      return;
    }

    // Reset all state variables to ensure a fresh start
    setStartAllInProgress(false); // Reset first to avoid race conditions

    // Check if we're connected to the server
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addToast({
        message: "Cannot start services: Not connected to server",
        type: "error",
      });
      return;
    }

    setStartAllInProgress(true);
    startAllInProgressRef.current = true;

    let currentIndex = 0;
    let startedCount = 0;
    let failedCount = 0;

    // A single live progress toast (sticky) replaces the previous burst of
    // per-service toasts. It updates in place as services come up and is
    // removed in finishStartAll, where the summary toast takes over.
    const total = activeServicesConfig.length;
    const progressToastId = addToast({
      message: `Starting services… (0/${total})`,
      type: "info",
      duration: 0,
    });
    const updateProgress = () => {
      updateToast(progressToastId, {
        message: `Starting services… (${startedCount}/${total})`,
      });
    };

    // Service IDs to skip because a dependency failed to start.
    const skippedServiceIds = new Set<string>();

    // Create a map to track service status changes
    const serviceStartPromises = new Map();
    const serviceStartTimeouts = new Map();

    // Compute the transitive set of services that (directly or indirectly)
    // depend on the given service, so we can skip them when it fails.
    function computeTransitiveDependents(failedId: string): Set<string> {
      const result = new Set<string>();
      const queue = [failedId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const svc of activeServicesConfig) {
          if (svc.dependsOn?.includes(current) && !result.has(svc.id)) {
            result.add(svc.id);
            queue.push(svc.id);
          }
        }
      }
      return result;
    }

    function startNextService() {
      if (currentIndex >= activeServicesConfig.length) {
        // All services processed
        finishStartAll();
        return;
      }

      const service = activeServicesConfig[currentIndex];

      // Skip services whose dependency failed earlier in the sequence.
      if (skippedServiceIds.has(service.id)) {
        currentIndex++;
        startNextService();
        return;
      }

      const currentStatus = serviceStatuses[service.id]?.status || "stopped";

      // Skip if already running, initializing, or starting
      if (
        currentStatus === "running" ||
        currentStatus === "initializing" ||
        currentStatus === "starting"
      ) {
        currentIndex++;
        startedCount++; // Count as started since it's already in progress
        updateProgress();
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

      // Create a promise that resolves when the service starts or fails
      const startPromise = new Promise((resolve) => {
        // Arm (or re-arm) a timeout for reaching the "running" state. Cleared
        // while the service is "initializing" so a long beforeStart hook does
        // not trip the timeout.
        const armTimeout = () => {
          const existing = serviceStartTimeouts.get(service.id);
          if (existing) clearTimeout(existing);
          const timeout = setTimeout(() => {
            if (serviceStartPromises.has(service.id)) {
              resolve({
                success: false,
                errorDetails: "Timed out waiting for service to start",
              });
            }
          }, 10000);
          serviceStartTimeouts.set(service.id, timeout);
        };

        const clearServiceTimeout = () => {
          const existing = serviceStartTimeouts.get(service.id);
          if (existing) {
            clearTimeout(existing);
            serviceStartTimeouts.delete(service.id);
          }
        };

        // Set up a listener for status changes
        const statusChangeListener = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (
              data.type === "status_update" &&
              data.serviceID === service.id
            ) {
              if (data.status === "initializing") {
                // Pre-start hook is running — don't time out while it works.
                clearServiceTimeout();
              } else if (data.status === "starting") {
                // Process is spawning — give it a fresh window to come up.
                armTimeout();
              } else if (data.status === "running") {
                // Service started successfully
                resolve({ success: true });
              } else if (data.status === "error" || data.status === "crashed") {
                // Service failed to start
                resolve({
                  success: false,
                  errorDetails: data.errorDetails || "Failed to start",
                });
              } else if (data.status === "stopped") {
                // The service was stopped before it finished coming up — e.g.
                // the user aborted a long/hung pre-start hook, or the
                // connection dropped. End this attempt so Start All doesn't
                // wait forever (there's no init timeout to fall back on).

                resolve({
                  success: false,
                  errorDetails: "Stopped before it finished starting",
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

          armTimeout();
        }
      });

      // Send start command
      sendAction(service.id, "start");

      // Wait for the service to start or fail
      startPromise.then(
        (result: { success: boolean; errorDetails?: string }) => {
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
            updateProgress();

            currentIndex++;
            startNextService();
          } else {
            // Service failed to start
            failedCount++;

            // Show error in toast
            addToast({
              message: `Failed to start ${service.name}: ${result.errorDetails}`,
              type: "error",
            });

            // Skip only the services that depend on this one (instead of
            // aborting the whole sequence), and keep starting the rest.
            const dependents = computeTransitiveDependents(service.id);
            for (const depId of dependents) {
              if (!skippedServiceIds.has(depId)) {
                skippedServiceIds.add(depId);
                const depName =
                  activeServicesConfig.find((s) => s.id === depId)?.name ||
                  depId;
                addLogMessage(
                  depId,
                  `Skipping ${depName} — dependency '${service.name}' failed`,
                  "system",
                  Date.now(),
                );
              }
            }

            currentIndex++;
            startNextService();
          }
        },
      );
    }

    function finishStartAll() {
      // Clean up any remaining listeners and timeouts
      for (const [, serviceData] of serviceStartPromises.entries()) {
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
      startAllInProgressRef.current = false;

      const skippedCount = skippedServiceIds.size;
      const hasIssues = failedCount > 0 || skippedCount > 0;

      let summaryMessage = "All services started!";
      if (hasIssues) {
        const parts = [`${startedCount} started`];
        if (failedCount > 0) parts.push(`${failedCount} failed`);
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
        summaryMessage = parts.join(", ");
      }

      // Morph the live progress toast into the summary in place rather than
      // removing it immediately, then let it linger before auto-dismissing.
      // An instant Start All finishes in a blink, so releasing the toast right
      // away would flash it off screen before it could be read.
      updateToast(progressToastId, {
        message: summaryMessage,
        type: hasIssues ? "warning" : "success",
      });
      setTimeout(() => removeToast(progressToastId), 4000);
    }

    startNextService();
  }

  // A service is considered "active" (and therefore stoppable) when it is
  // running, initializing, starting, or stopping.
  const hasActiveServices = activeServicesConfig.some((service) => {
    const status = serviceStatuses[service.id]?.status;
    return (
      status === "running" ||
      status === "initializing" ||
      status === "starting" ||
      status === "stopping"
    );
  });

  function stopAllServices() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addToast({
        message: "Cannot stop services: Not connected to server",
        type: "error",
      });
      return;
    }

    if (!hasActiveServices) {
      addToast({
        message: "No running services to stop",
        type: "info",
      });
      return;
    }

    // The backend stops services sequentially in reverse dependency order and
    // broadcasts per-service status updates as each one shuts down.
    sendGlobalAction("stop_all");
    addToast({
      message: "Stopping all services...",
      type: "info",
    });
  }

  // Returns a service's declared dependencies that aren't currently up. A dep
  // that's running or on its way up (starting/initializing) counts as fine.
  function getUnmetDependencies(service: ServiceConfig) {
    if (!service.dependsOn || service.dependsOn.length === 0) return [];
    return service.dependsOn
      .map((depId) => ({
        id: depId,
        name: activeServicesConfig.find((s) => s.id === depId)?.name || depId,
        status: serviceStatuses[depId]?.status || "stopped",
      }))
      .filter(
        (dep) => !["running", "starting", "initializing"].includes(dep.status),
      );
  }

  // Manually start a service, warning (but not blocking) if its dependencies
  // aren't running yet.
  function startServiceWithDepCheck(service: ServiceConfig) {
    const unmet = getUnmetDependencies(service);
    sendAction(service.id, "start");

    if (unmet.length === 1) {
      addToast({
        message: `Starting ${service.name}, but ${unmet[0].name} is ${unmet[0].status}.`,
        type: "warning",
        duration: 5000,
      });
    } else if (unmet.length > 1) {
      addToast({
        message: `Starting ${service.name}, but its dependencies aren't running: ${unmet
          .map((d) => d.name)
          .join(", ")}.`,
        type: "warning",
        duration: 5000,
      });
    } else {
      addToast({
        message: `Starting ${service.name}...`,
        type: "info",
        duration: 3000,
      });
    }
  }

  return (
    <>
      <Header
        onStartAll={startAllServices}
        onStopAll={stopAllServices}
        startAllInProgress={startAllInProgress}
        stopAllDisabled={!hasActiveServices}
        hasServices={!isLoading && activeServicesConfig.length > 0}
        dashboardName={dashboardName}
      />
      <TabNavigation
        services={isLoading ? [] : activeServicesConfig}
        activeTabId={activeTabId}
        onTabSwitch={switchTab}
        serviceStatuses={serviceStatuses}
      />
      <ToastContainer />
      <div className="main-content">
        <div className="tab-content-container">
          {isLoading ? (
            <div className="tab-content active">
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  height: "400px",
                  color: "#666",
                  fontSize: "1.1rem",
                }}
              >
                Loading services...
              </div>
            </div>
          ) : loadError ? (
            <div className="tab-content active">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  alignItems: "center",
                  height: "400px",
                  color: "#e74c3c",
                  fontSize: "1.1rem",
                  textAlign: "center",
                  gap: "10px",
                }}
              >
                <div>Failed to load services</div>
                <div style={{ fontSize: "0.9rem", color: "#666" }}>
                  {loadError}
                </div>
              </div>
            </div>
          ) : activeServicesConfig.length === 0 ? (
            <div className="tab-content active">
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  height: "400px",
                  color: "#888",
                  fontSize: "1.1rem",
                }}
              >
                No services configured
              </div>
            </div>
          ) : (
            (() => {
              const activeService = activeServicesConfig.find(
                (s) => s.id === activeTabId,
              );
              return activeService ? (
                <ServiceTab
                  key={activeService.id}
                  service={activeService}
                  isActive={true}
                  status={serviceStatuses[activeService.id]}
                  connectionStatus={connectionStatuses[activeService.id]}
                  logs={serviceLogs[activeService.id] || ""}
                  autoScroll={
                    autoScrollStates[activeService.id] !== undefined
                      ? autoScrollStates[activeService.id]
                      : true
                  }
                  onStart={() => startServiceWithDepCheck(activeService)}
                  onStop={() => {
                    sendAction(activeService.id, "stop");
                    addToast({
                      message: `Stopping ${activeService.name}...`,
                      type: "info",
                      duration: 3000,
                    });
                  }}
                  onRestart={() => {
                    sendAction(activeService.id, "restart");
                    addToast({
                      message: `Restarting ${activeService.name}...`,
                      type: "info",
                      duration: 3000,
                    });
                  }}
                  onClearLogs={() => {
                    clearLogs(activeService.id);
                    addToast({
                      message: `Cleared logs for ${activeService.name}`,
                      type: "success",
                      duration: 2000,
                    });
                  }}
                  onToggleAutoScroll={() => {
                    const currentState =
                      autoScrollStates[activeService.id] !== undefined
                        ? autoScrollStates[activeService.id]
                        : true;
                    toggleAutoScroll(activeService.id);
                    addToast({
                      message: `Auto-scroll ${!currentState ? "enabled" : "disabled"} for ${activeService.name}`,
                      type: "info",
                      duration: 1500,
                    });
                  }}
                  onSendSignal={(signal) => {
                    sendAction(activeService.id, "send_signal", { signal });
                    addToast({
                      message: `Sent ${signal} to ${activeService.name}`,
                      type: "info",
                      duration: 2000,
                    });
                  }}
                />
              ) : null;
            })()
          )}
        </div>
      </div>
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
