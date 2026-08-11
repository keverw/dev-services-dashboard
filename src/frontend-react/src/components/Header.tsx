import { useTheme } from "../contexts/ThemeContext";
import { useState, useEffect } from "react";

interface HeaderProps {
  onStartAll?: () => void;
  /** `force` is true when escalating a Stop All that's already running. */
  onStopAll?: (force?: boolean) => void;
  onToggleOverview?: () => void;
  overviewActive?: boolean;
  startAllInProgress?: boolean;
  stopAllDisabled?: boolean;
  /** A Stop All run is under way, so the button offers to escalate it. */
  stopAllInProgress?: boolean;
  hasServices?: boolean;
  dashboardName?: string;
}

function Header({
  onStartAll,
  onStopAll,
  onToggleOverview,
  overviewActive,
  startAllInProgress,
  stopAllDisabled,
  stopAllInProgress,
  hasServices,
  dashboardName,
}: HeaderProps) {
  const { mode, setMode } = useTheme();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);
    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  useEffect(() => {
    // Set CSS custom property for header height
    const updateHeaderHeight = () => {
      const header = document.querySelector("header");
      if (header) {
        const height = header.offsetHeight;
        document.documentElement.style.setProperty(
          "--header-height",
          `${height}px`,
        );
      }
    };

    // Update on mount and when mobile state changes
    setTimeout(updateHeaderHeight, 0);
    window.addEventListener("resize", updateHeaderHeight);

    return () => window.removeEventListener("resize", updateHeaderHeight);
  }, [isMobile]);

  const handleThemeChange = (theme: "auto" | "light" | "dark") => {
    setMode(theme);
  };

  const themeToggle = (
    <div className="theme-toggle-group">
      <button
        className={`theme-toggle-btn ${mode === "auto" ? "active" : ""}`}
        onClick={() => handleThemeChange("auto")}
        title="Auto theme"
      >
        Auto
      </button>
      <button
        className={`theme-toggle-btn ${mode === "light" ? "active" : ""}`}
        onClick={() => handleThemeChange("light")}
        title="Light theme"
      >
        Light
      </button>
      <button
        className={`theme-toggle-btn ${mode === "dark" ? "active" : ""}`}
        onClick={() => handleThemeChange("dark")}
        title="Dark theme"
      >
        Dark
      </button>
    </div>
  );

  const startButton = hasServices &&
    (onStartAll || onStopAll || onToggleOverview) && (
      <div className="header-controls">
        {onToggleOverview && (
          <button
            className={`overview-header-btn ${overviewActive ? "active" : ""}`}
            onClick={onToggleOverview}
            title="Overview of all services"
          >
            Overview
          </button>
        )}
        {onStartAll && (
          <button
            className="start-all-header-btn"
            onClick={onStartAll}
            disabled={startAllInProgress}
            title="Start all services"
          >
            Start All
          </button>
        )}
        {onStopAll && (
          // Same escalate-on-second-press idea as a service's own Stop button:
          // while a Stop All is running the button stays live and offers to
          // force the whole run, instead of greying out for its duration.
          <button
            className={
              stopAllInProgress
                ? "stop-all-header-btn force-stop"
                : "stop-all-header-btn"
            }
            onClick={() => onStopAll(stopAllInProgress)}
            disabled={stopAllDisabled}
            title={
              stopAllInProgress
                ? "Force stop all services — SIGKILL now, without waiting out their grace periods"
                : "Stop all services"
            }
          >
            {stopAllInProgress ? "Force Stop All" : "Stop All"}
          </button>
        )}
      </div>
    );

  const title = dashboardName || "Dev Services Dashboard";

  return (
    <header>
      <div className="header-content">
        {isMobile ? (
          // Mobile: Two-row layout
          <>
            <div className="header-controls-row">
              {themeToggle}
              {startButton}
            </div>
            <div className="header-title-row">
              <h1>{title}</h1>
            </div>
          </>
        ) : (
          // Desktop: Single-row layout
          <div className="header-single-row">
            {themeToggle}
            <h1 className="header-center-title">{title}</h1>
            {startButton}
          </div>
        )}
      </div>
    </header>
  );
}

export default Header;
