import { useEffect, useState } from "react";
import { StartAllStatus } from "../types";

interface ToastProps {
  status: StartAllStatus;
  onDismiss: () => void;
}

function Toast({ status, onDismiss }: ToastProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (status.message) {
      setIsVisible(true);
      setIsExiting(false);

      // Auto-dismiss after 4 seconds
      const timer = setTimeout(() => {
        setIsExiting(true);
        setTimeout(() => {
          setIsVisible(false);
          onDismiss();
        }, 300); // Wait for exit animation
      }, 4000);

      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
      setIsExiting(false);
    }
  }, [status.message, onDismiss]);

  if (!isVisible || !status.message) {
    return null;
  }

  const getToastClass = () => {
    let baseClass = "toast";

    if (isExiting) {
      baseClass += " toast-exit";
    } else {
      baseClass += " toast-enter";
    }

    switch (status.type) {
      case "success":
        return `${baseClass} toast-success`;
      case "error":
        return `${baseClass} toast-error`;
      case "warning":
        return `${baseClass} toast-warning`;
      default:
        return `${baseClass} toast-info`;
    }
  };

  const getIcon = () => {
    switch (status.type) {
      case "success":
        return "✓";
      case "error":
        return "✕";
      case "warning":
        return "⚠";
      default:
        return "ℹ";
    }
  };

  return (
    <div className={getToastClass()}>
      <div className="toast-icon">{getIcon()}</div>
      <div className="toast-message">{status.message}</div>
      <button
        className="toast-close"
        onClick={() => {
          setIsExiting(true);
          setTimeout(() => {
            setIsVisible(false);
            onDismiss();
          }, 300);
        }}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

export default Toast;
