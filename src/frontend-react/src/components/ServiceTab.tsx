import { useEffect, useRef } from "react";
import { ServiceConfig } from "../types";
import { useToast } from "../contexts/ToastContext";

interface ServiceTabProps {
  service: ServiceConfig;
  isActive: boolean;
  status?: { status: string; errorDetails?: string };
  connectionStatus?: { status: string; message: string };
  logs: string;
  autoScroll: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onClearLogs: () => void;
  onToggleAutoScroll: () => void;
}

function ServiceTab({
  service,
  isActive,
  status,
  connectionStatus,
  logs,
  autoScroll,
  onStart,
  onStop,
  onRestart,
  onClearLogs,
  onToggleAutoScroll,
}: ServiceTabProps) {
  const logsRef = useRef<HTMLPreElement>(null);
  const { addToast } = useToast();

  // Auto-scroll to bottom when logs change and auto-scroll is enabled
  useEffect(() => {
    if (autoScroll && logsRef.current && isActive) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, autoScroll, isActive]);

  // When tab becomes active, scroll to bottom if auto-scroll is enabled
  useEffect(() => {
    if (isActive && autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [isActive, autoScroll]);

  const currentStatus = status?.status || "stopped";
  const capitalizedStatus =
    currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1);

  const isStartDisabled =
    currentStatus === "running" ||
    currentStatus === "starting" ||
    currentStatus === "stopping";
  const isStopDisabled =
    currentStatus === "stopped" ||
    currentStatus === "error" ||
    currentStatus === "crashed" ||
    currentStatus === "starting" ||
    currentStatus === "stopping";
  const isRestartDisabled =
    currentStatus === "starting" || currentStatus === "stopping";

  const createWebLinkButtons = () => {
    if (!service.webLinks || service.webLinks.length === 0) {
      return null;
    }

    return service.webLinks.map((link, index) => (
      <button
        key={index}
        id={`${service.id}-weblink-${index}`}
        className="web-link-button"
        title={`Open ${link.label}`}
        onClick={() => {
          window.open(link.url, "_blank");
          addToast({
            message: `Opened ${link.label} for ${service.name}`,
            type: "info",
            duration: 2000,
          });
        }}
      >
        <i>🔗</i>
        {link.label}
      </button>
    ));
  };

  return (
    <div
      className={`tab-content ${isActive ? "active" : ""}`}
      id={`content-${service.id}`}
      role="tabpanel"
      aria-labelledby={`tab-${service.id}`}
      tabIndex={0}
    >
      <div className="service-header">
        <h2 className="service-title">{service.name}</h2>
        <div className="service-status">
          <span
            className={`status-indicator status-${currentStatus}`}
            id={`${service.id}-status-indicator`}
          />
          <span id={`${service.id}-status-text`}>{capitalizedStatus}</span>
        </div>
      </div>

      <div className="service-content">
        {(currentStatus === "error" || currentStatus === "crashed") &&
          status?.errorDetails && (
            <div
              id={`${service.id}-error-details`}
              className="error-details"
              style={{ display: "block" }}
            >
              {currentStatus === "crashed" ? "Crash" : "Error"}:{" "}
              {status.errorDetails}
            </div>
          )}

        <div className="controls">
          <button
            id={`${service.id}-start`}
            title={`Start ${service.name}`}
            onClick={onStart}
            disabled={isStartDisabled}
          >
            Start
          </button>
          <button
            id={`${service.id}-stop`}
            className="stop-button"
            title={`Stop ${service.name}`}
            onClick={onStop}
            disabled={isStopDisabled}
          >
            Stop
          </button>
          <button
            id={`${service.id}-restart`}
            className="restart-button"
            title={`Restart ${service.name}`}
            onClick={onRestart}
            disabled={isRestartDisabled}
          >
            Restart
          </button>
          <button
            id={`${service.id}-clear-logs`}
            className="clear-logs-button"
            title={`Clear logs for ${service.name}`}
            onClick={onClearLogs}
          >
            Clear Logs
          </button>
          {createWebLinkButtons()}
        </div>

        <div className="logs-container">
          <div className="log-controls">
            <h3>Logs</h3>
          </div>

          <div className="log-status-bar">
            <div
              id={`${service.id}-connection-status`}
              className="connection-status"
            >
              <span
                className={`connection-indicator ${connectionStatus?.status || "connecting"}`}
              />
              <span id={`${service.id}-connection-text`}>
                {connectionStatus?.message || "Awaiting connection..."}
              </span>
            </div>
            <label
              className="auto-scroll-toggle"
              htmlFor={`${service.id}-auto-scroll`}
            >
              <div className="checkbox-container">
                <input
                  type="checkbox"
                  id={`${service.id}-auto-scroll`}
                  checked={autoScroll}
                  onChange={onToggleAutoScroll}
                />
                <span className="custom-checkbox" />
              </div>
              Auto-scroll
            </label>
          </div>

          <pre
            ref={logsRef}
            id={`${service.id}-logs`}
            className="logs-area"
            role="log"
            aria-live="polite"
            aria-label={`${service.name} service logs`}
          >
            {logs}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default ServiceTab;
