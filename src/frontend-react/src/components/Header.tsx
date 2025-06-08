interface HeaderProps {
  onStartAll?: () => void;
  startAllInProgress?: boolean;
  hasServices?: boolean;
}

function Header({ onStartAll, startAllInProgress, hasServices }: HeaderProps) {
  return (
    <header>
      <div className="header-content">
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
