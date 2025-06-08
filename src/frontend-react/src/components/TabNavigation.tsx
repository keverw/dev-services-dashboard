import { ServiceConfig } from "../types";

interface TabNavigationProps {
  services: ServiceConfig[];
  activeTabId: string | null;
  onTabSwitch: (serviceId: string) => void;
  onStartAll: () => void;
  startAllInProgress: boolean;
  startAllStatus: { message: string; color?: string };
  serviceStatuses: {
    [serviceId: string]: { status: string; errorDetails?: string };
  };
}

function TabNavigation({
  services,
  activeTabId,
  onTabSwitch,
  onStartAll,
  startAllInProgress,
  startAllStatus,
  serviceStatuses,
}: TabNavigationProps) {
  return (
    <div className="tab-container">
      <div className="tab-nav">
        <div className="tabs-left" role="tablist">
          {services.map((service) => {
            const status = serviceStatuses[service.id]?.status || "stopped";
            return (
              <button
                key={service.id}
                className={`tab-button ${activeTabId === service.id ? "active" : ""}`}
                id={`tab-${service.id}`}
                role="tab"
                aria-controls={`content-${service.id}`}
                aria-selected={activeTabId === service.id}
                title={`View ${service.name} service`}
                onClick={() => onTabSwitch(service.id)}
              >
                <span
                  className={`tab-status-indicator status-${status}`}
                  id={`${service.id}-tab-status-indicator`}
                />
                <span>{service.name}</span>
              </button>
            );
          })}
        </div>
        <div className="global-controls">
          <button
            id="start-all-btn"
            title="Start all services"
            onClick={onStartAll}
            disabled={startAllInProgress}
          >
            Start All
          </button>
          <span
            id="start-all-status"
            className="start-all-status"
            style={{ color: startAllStatus.color }}
          >
            {startAllStatus.message}
          </span>
        </div>
      </div>
    </div>
  );
}

export default TabNavigation;
