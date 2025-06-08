import { useTheme } from "../contexts/ThemeContext";

interface HeaderProps {
  onStartAll?: () => void;
  startAllInProgress?: boolean;
  hasServices?: boolean;
}

function Header({ onStartAll, startAllInProgress, hasServices }: HeaderProps) {
  const { mode, setMode } = useTheme();

  const handleThemeChange = (theme: "auto" | "light" | "dark") => {
    setMode(theme);
  };

  return (
    <header>
      <div className="header-content">
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
        <h1>Dev Services Dashboard</h1>
        {hasServices && onStartAll && (
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
        )}
      </div>
    </header>
  );
}

export default Header;
