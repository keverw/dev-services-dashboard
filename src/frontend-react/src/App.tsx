import { useState, useEffect, useRef } from "react";
import {
  ServiceConfig,
  AutoScrollStates,
  ServicesConfigResponse,
} from "./types";
import type { ServerMessage } from "@shared/protocol";
import Header from "./components/Header";
import TabNavigation from "./components/TabNavigation";
import ServiceTab from "./components/ServiceTab";
import ServiceOverview from "./components/ServiceOverview";
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
  const [showOverview, setShowOverview] = useState(false);
  const [connected, setConnected] = useState(false);
  // Id of the sticky "Disconnected" toast, so we can remove it on reconnect.
  const disconnectToastIdRef = useRef<string | null>(null);

  // Id of the live, server-driven "Start All" progress toast.
  const startAllProgressToastIdRef = useRef<string | null>(null);
  const [stopAllInProgress, setStopAllInProgress] = useState(false);
  const stopAllInProgressRef = useRef(false);
  const stopAllProgressToastIdRef = useRef<string | null>(null);
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

  function handleWebSocketMessage(data: ServerMessage) {
    switch (data.type) {
      case "initial_state":
        if (data.services) {
          const services = data.services;
          services.forEach((s) => {
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

          // Reconcile web links from the authoritative initial_state. A
          // beforeStart/afterStart hook can change a service's links (and a
          // stop reverts them to the baseline), and a links_update broadcast
          // can be missed while disconnected — and /api/services-config is only
          // fetched once on mount — so refresh them here on every (re)connect.
          setActiveServicesConfig((prev) =>
            prev.map((cfg) => {
              const fresh = services.find((s) => s.id === cfg.id);
              return fresh ? { ...cfg, webLinks: fresh.webLinks ?? [] } : cfg;
            }),
          );
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
          // (but not during Start All / Stop All — those drive their own
          // per-service toasts, so this would duplicate them)
          if (!startAllInProgressRef.current && !stopAllInProgressRef.current) {
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
      case "start_all_begin":
        // Server is orchestrating Start All. We mute the raw per-service status
        // toasts (to avoid duplicates) and instead drive our own per-service +
        // progress toasts from the start_all_* messages below. The sticky
        // progress toast stays pinned at the top of the stack.
        setStartAllInProgress(true);
        startAllInProgressRef.current = true;
        startAllProgressToastIdRef.current = addToast({
          message: `Starting services… (0/${data.total ?? 0})`,
          type: "info",
          duration: 0,
        });
        break;
      case "start_all_progress":
        // If we joined a Start All already in flight (e.g. a refresh that missed
        // start_all_begin), initialize now so raw status toasts stay suppressed
        // and a progress toast shows. (If the run already finished during the
        // reconnect gap, no progress events arrive and initial_state shows the
        // final statuses — nothing to do.)
        if (!startAllInProgressRef.current) {
          setStartAllInProgress(true);
          startAllInProgressRef.current = true;
        }
        if (startAllProgressToastIdRef.current) {
          updateToast(startAllProgressToastIdRef.current, {
            message: `Starting services… (${data.started ?? 0}/${data.total ?? 0})`,
          });
        } else {
          startAllProgressToastIdRef.current = addToast({
            message: `Starting services… (${data.started ?? 0}/${data.total ?? 0})`,
            type: "info",
            duration: 0,
          });
        }

        if (data.result === "started") {
          // Surface each service as it comes up (short-lived so they don't pile
          // up); the pinned progress toast tracks the overall count.
          addToast({
            message: `${data.serviceName || data.serviceID} started successfully!`,
            type: "success",
            duration: 2000,
          });
        } else if (data.result === "failed") {
          addToast({
            message: `Failed to start ${data.serviceName || data.serviceID}: ${data.errorDetails || "Failed to start"}`,
            type: "error",
          });
        }

        // Per-service skip log lines are broadcast by the server as normal log
        // messages, so there's nothing extra to do for "skipped" here.
        break;
      case "start_all_done": {
        setStartAllInProgress(false);
        startAllInProgressRef.current = false;

        const started = data.started ?? 0;
        const failed = data.failed ?? 0;
        const skippedCount = data.skipped ?? 0;
        const hasIssues = failed > 0 || skippedCount > 0;

        let summary = "All services started!";

        if (hasIssues) {
          const parts = [`${started} started`];
          if (failed > 0) parts.push(`${failed} failed`);
          if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
          summary = parts.join(", ");
        }

        const toastId = startAllProgressToastIdRef.current;
        if (toastId) {
          // Morph the progress toast into the summary, then let it linger.
          updateToast(toastId, {
            message: summary,
            type: hasIssues ? "warning" : "success",
          });
          setTimeout(() => removeToast(toastId), 4000);
          startAllProgressToastIdRef.current = null;
        } else {
          addToast({
            message: summary,
            type: hasIssues ? "warning" : "success",
            duration: 4000,
          });
        }
        break;
      }
      case "stop_all_begin":
        setStopAllInProgress(true);
        stopAllInProgressRef.current = true;
        stopAllProgressToastIdRef.current = addToast({
          message: `Stopping services… (0/${data.total ?? 0})`,
          type: "info",
          duration: 0,
        });

        break;
      case "stop_all_progress":
        // Lazy-join a Stop All already in flight (e.g. after a refresh), same as
        // Start All above.
        if (!stopAllInProgressRef.current) {
          setStopAllInProgress(true);
          stopAllInProgressRef.current = true;
        }
        if (stopAllProgressToastIdRef.current) {
          updateToast(stopAllProgressToastIdRef.current, {
            message: `Stopping services… (${data.stopped ?? 0}/${data.total ?? 0})`,
          });
        } else {
          stopAllProgressToastIdRef.current = addToast({
            message: `Stopping services… (${data.stopped ?? 0}/${data.total ?? 0})`,
            type: "info",
            duration: 0,
          });
        }

        if (data.result === "stopped") {
          addToast({
            message: `${data.serviceName || data.serviceID} stopped`,
            type: "info",
            duration: 2000,
          });
        } else if (data.result === "failed") {
          addToast({
            message: `${data.serviceName || data.serviceID} failed to stop`,
            type: "error",
            duration: 4000,
          });
        }

        break;
      case "stop_all_done": {
        setStopAllInProgress(false);
        stopAllInProgressRef.current = false;
        const stopped = data.stopped ?? 0;
        const failed = data.failed ?? 0;
        const base =
          stopped === 1 ? "1 service stopped" : `${stopped} services stopped`;
        const summary = failed > 0 ? `${base}, ${failed} failed` : base;
        const toastId = stopAllProgressToastIdRef.current;
        const summaryType = failed > 0 ? "error" : "info";

        if (toastId) {
          updateToast(toastId, { message: summary, type: summaryType });
          setTimeout(() => removeToast(toastId), 4000);
          stopAllProgressToastIdRef.current = null;
        } else {
          addToast({ message: summary, type: summaryType, duration: 4000 });
        }

        break;
      }
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
          addToast({
            message: `Server error: ${data.message}`,
            type: "error",
            duration: 5000,
          });
        }
        break;
    }
  }

  function handleWebSocketOpen() {
    setConnected(true);
    // Clear the sticky "Disconnected" toast now that we're back.
    if (disconnectToastIdRef.current) {
      removeToast(disconnectToastIdRef.current);
      disconnectToastIdRef.current = null;
    }
    activeServicesConfig.forEach((service) => {
      updateConnectionStatus(service.id, "connected", "Connected");
    });
  }

  function handleWebSocketClose() {
    setConnected(false);
    // A Start All in flight won't get its `start_all_done` now — reset so the
    // UI isn't wedged, and drop its progress toast.
    setStartAllInProgress(false);
    startAllInProgressRef.current = false;

    if (startAllProgressToastIdRef.current) {
      removeToast(startAllProgressToastIdRef.current);
      startAllProgressToastIdRef.current = null;
    }

    setStopAllInProgress(false);
    stopAllInProgressRef.current = false;

    if (stopAllProgressToastIdRef.current) {
      removeToast(stopAllProgressToastIdRef.current);
      stopAllProgressToastIdRef.current = null;
    }

    // Show a single sticky toast until we reconnect.
    if (!disconnectToastIdRef.current) {
      disconnectToastIdRef.current = addToast({
        message: "Disconnected from server — reconnecting…",
        type: "error",
        duration: 0,
      });
    }
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
    setConnected(false);
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
    setShowOverview(false);
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
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      addToast({
        message: "Cannot start services: Not connected to server",
        type: "error",
      });
      return;
    }
    if (startAllInProgress) {
      addToast({
        message: "Start All is already in progress…",
        type: "warning",
      });
      return;
    }
    // The server orchestrates Start All (dependency order, per-service waits,
    // skipping dependents of failures) and broadcasts progress; we just kick it
    // off and render the start_all_* messages.
    setStartAllInProgress(true);
    startAllInProgressRef.current = true;
    sendGlobalAction("start_all");
  }

  // A service is considered "active" (and therefore stoppable) when it is
  // running, initializing, starting, finalizing, or stopping.
  const hasActiveServices = activeServicesConfig.some((service) => {
    const status = serviceStatuses[service.id]?.status;
    return (
      status === "running" ||
      status === "initializing" ||
      status === "starting" ||
      status === "finalizing" ||
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

    // The server stops services in reverse dependency order and broadcasts
    // stop_all_* progress; we just render those (suppress our own toast here).
    sendGlobalAction("stop_all");
  }

  // Returns a service's declared dependencies that aren't currently up. A dep
  // that's running or on its way up (starting/initializing/finalizing) is fine.
  function getUnmetDependencies(service: ServiceConfig) {
    if (!service.dependsOn || service.dependsOn.length === 0) return [];
    return service.dependsOn
      .map((depId) => ({
        id: depId,
        name: activeServicesConfig.find((s) => s.id === depId)?.name || depId,
        status: serviceStatuses[depId]?.status || "stopped",
      }))
      .filter(
        (dep) =>
          !["running", "starting", "initializing", "finalizing"].includes(
            dep.status,
          ),
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
        onToggleOverview={() => setShowOverview((v) => !v)}
        overviewActive={showOverview}
        startAllInProgress={startAllInProgress || !connected}
        stopAllDisabled={!hasActiveServices || stopAllInProgress || !connected}
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
        <div className={`tab-content-container ${isLoading ? "" : "loaded"}`}>
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
          ) : showOverview ? (
            <ServiceOverview
              services={activeServicesConfig}
              serviceStatuses={serviceStatuses}
              onSelect={switchTab}
            />
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
                  connected={connected}
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
