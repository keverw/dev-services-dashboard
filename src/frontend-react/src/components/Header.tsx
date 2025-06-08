import { useTheme } from "../contexts/ThemeContext";
import { useState, useEffect } from "react";

interface HeaderProps {
  onStartAll?: () => void;
  startAllInProgress?: boolean;
  hasServices?: boolean;
  dashboardName?: string;
}

function Header({
  onStartAll,
  startAllInProgress,
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

  const startButton = hasServices && onStartAll && (
    <div className="header-controls">
      <button
        className="start-all-header-btn"
        onClick={onStartAll}
        disabled={startAllInProgress}
        title="Start all services"
      >
        Start All
      </button>
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
