import { ServiceConfig } from "../types";

interface ServiceOverviewProps {
  services: ServiceConfig[];
  serviceStatuses: {
    [serviceId: string]: { status: string; errorDetails?: string };
  };
  onSelect: (serviceId: string) => void;
}

// A grid overview of every service and its current status. Clicking a card
// jumps straight to that service's tab, handy when there are more services
// than fit in the tab bar.
function ServiceOverview({
  services,
  serviceStatuses,
  onSelect,
}: ServiceOverviewProps) {
  return (
    <div className="overview">
      <h2 className="overview-title">All Services</h2>
      <div className="overview-grid">
        {services.map((service) => {
          const status = serviceStatuses[service.id]?.status || "stopped";
          const label = status.charAt(0).toUpperCase() + status.slice(1);
          return (
            <button
              key={service.id}
              className="overview-card"
              onClick={() => onSelect(service.id)}
              title={`Jump to ${service.name}`}
            >
              <span
                className={`status-indicator status-${status}`}
                aria-hidden="true"
              />
              <span className="overview-card-name">{service.name}</span>
              <span className="overview-card-status">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ServiceOverview;
