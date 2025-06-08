import { ServiceConfig } from "../types";
import { useEffect, useState, useRef } from "react";

interface TabNavigationProps {
  services: ServiceConfig[];
  activeTabId: string | null;
  onTabSwitch: (serviceId: string) => void;
  serviceStatuses: {
    [serviceId: string]: { status: string; errorDetails?: string };
  };
}

function TabNavigation({
  services,
  activeTabId,
  onTabSwitch,
  serviceStatuses,
}: TabNavigationProps) {
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [needsScroll, setNeedsScroll] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Check if scroll arrows are needed
  const checkScrollArrows = () => {
    if (tabsRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = tabsRef.current;

      // Simple threshold to prevent trackpad micro-scrolling false positives
      const scrollThreshold = 10;
      const hasOverflow = scrollWidth > clientWidth + scrollThreshold;

      // Update scroll state for CSS overflow control
      // Note: Browsers seem to treat any element with overflow:auto as scrollable, even with no actual overflow.
      // This allows macOS trackpad to trigger phantom scroll events and show false scroll arrows.
      // When there are only 3 tabs, there's no real overflow but the system still thinks it's scrollable.
      // Solution: Dynamically toggle overflow-x between 'hidden' (no scroll) and 'auto' (scrollable)
      // based on actual content overflow, preventing phantom scrolling entirely.
      // For the ghost of Steve Jobs - even he couldn't have predicted this trackpad chaos! 👻
      setNeedsScroll(hasOverflow);

      // Only show arrows if there's actual overflow
      if (!hasOverflow) {
        setShowLeftArrow(false);
        setShowRightArrow(false);
        return;
      }

      // Show arrows based on scroll position with threshold
      setShowLeftArrow(scrollLeft > scrollThreshold);
      setShowRightArrow(
        scrollLeft < scrollWidth - clientWidth - scrollThreshold,
      );
    }
  };

  // Check scroll arrows on mount and when services change
  useEffect(() => {
    checkScrollArrows();
    const handleResize = () => checkScrollArrows();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [services]);

  // Scroll functions
  const scrollLeft = () => {
    if (tabsRef.current) {
      tabsRef.current.scrollBy({ left: -200, behavior: "smooth" });
      setTimeout(checkScrollArrows, 300);
    }
  };

  const scrollRight = () => {
    if (tabsRef.current) {
      tabsRef.current.scrollBy({ left: 200, behavior: "smooth" });
      setTimeout(checkScrollArrows, 300);
    }
  };

  // Scroll to active tab when it changes
  useEffect(() => {
    if (activeTabId && tabsRef.current) {
      const activeTab = document.getElementById(`tab-${activeTabId}`);
      if (activeTab) {
        const container = tabsRef.current;
        const tabRect = activeTab.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Check if tab is outside visible area
        if (
          tabRect.left < containerRect.left ||
          tabRect.right > containerRect.right
        ) {
          // Scroll to center the active tab
          const scrollLeft =
            activeTab.offsetLeft -
            container.offsetWidth / 2 +
            activeTab.offsetWidth / 2;
          container.scrollTo({ left: scrollLeft, behavior: "smooth" });
          setTimeout(checkScrollArrows, 300);
        }
      }
    }
  }, [activeTabId]);
  return (
    <div className="tab-container">
      <div className="tab-nav">
        <button
          className={`scroll-arrow left ${showLeftArrow ? "" : "hidden"}`}
          onClick={scrollLeft}
          title="Scroll tabs left"
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
        <div className="tabs-scroll-container">
          <div
            className="tabs-left"
            role="tablist"
            ref={tabsRef}
            onScroll={checkScrollArrows}
            style={{
              overflowX: needsScroll ? "auto" : "hidden",
            }}
          >
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
        </div>
        <button
          className={`scroll-arrow right ${showRightArrow ? "" : "hidden"}`}
          onClick={scrollRight}
          title="Scroll tabs right"
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      </div>
    </div>
  );
}

export default TabNavigation;
