import { useEffect, useState } from "react";
import { useToast, Toast } from "../contexts/ToastContext";

interface ToastItemProps {
  toast: Toast;
  index: number;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, index, onRemove }: ToastItemProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Trigger enter animation immediately
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const handleRemove = () => {
    setIsExiting(true);
    setTimeout(() => {
      onRemove(toast.id);
    }, 400); // Match the exit animation duration
  };

  const getToastClass = () => {
    let baseClass = "toast-item";

    if (isExiting) {
      baseClass += " toast-exit";
    } else if (isVisible) {
      baseClass += " toast-enter";
    }

    switch (toast.type) {
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
    switch (toast.type) {
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
      <div className="toast-message">{toast.message}</div>
      <button
        className="toast-close"
        onClick={handleRemove}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-container">
      {toasts.map((toast, index) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          index={index}
          onRemove={removeToast}
        />
      ))}
    </div>
  );
}

export default ToastContainer;
