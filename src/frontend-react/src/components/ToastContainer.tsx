import { useToast, Toast } from "../contexts/ToastContext";

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const getToastClass = () => {
    let baseClass = "toast-item";

    // The enter/exit animations are keyframe animations that play from their
    // off-screen state, so the class is applied immediately. Exit is driven by
    // the centrally-managed `exiting` flag so auto-dismiss, manual close, and
    // overflow-eviction all animate out the same way.
    baseClass += toast.exiting ? " toast-exit" : " toast-enter";

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
        onClick={() => onRemove(toast.id)}
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

  // Pin sticky toasts (duration 0, e.g. the Start All progress toast) to the
  // top so transient per-service toasts stream in below them rather than
  // shoving them down.
  const ordered = [
    ...toasts.filter((t) => t.duration === 0),
    ...toasts.filter((t) => t.duration !== 0),
  ];

  return (
    <div className="toast-container">
      {ordered.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}

export default ToastContainer;
