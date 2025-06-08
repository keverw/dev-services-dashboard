import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning" | "info";
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  clearAllToasts: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutRefs = useState(new Map<string, NodeJS.Timeout>())[0];

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).substr(2, 9);

    // Set different default durations based on toast type
    let defaultDuration = 4000;
    if (
      toast.type === "success" &&
      toast.message.includes("started successfully")
    ) {
      defaultDuration = 2500; // Shorter for individual service successes
    } else if (toast.type === "info" && toast.message.includes("Starting")) {
      defaultDuration = 3000; // Medium for progress updates
    } else if (toast.type === "warning") {
      defaultDuration = 5000; // Longer for warnings
    } else if (toast.type === "error") {
      defaultDuration = 6000; // Longest for errors
    }

    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration || defaultDuration,
    };

    setToasts((prev) => {
      // Add new toast at the beginning (newest first)
      const newToasts = [newToast, ...prev];
      // Keep only the last 6 toasts (increased from 5)
      return newToasts.slice(0, 6);
    });

    // Auto-remove after duration
    const timeout = setTimeout(() => {
      removeToast(id);
    }, newToast.duration);

    timeoutRefs.set(id, timeout);
  }, []);

  const removeToast = useCallback(
    (id: string) => {
      // Clear the timeout if it exists
      const timeout = timeoutRefs.get(id);
      if (timeout) {
        clearTimeout(timeout);
        timeoutRefs.delete(id);
      }

      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [timeoutRefs],
  );

  const clearAllToasts = useCallback(() => {
    // Clear all timeouts
    timeoutRefs.forEach((timeout) => clearTimeout(timeout));
    timeoutRefs.clear();
    setToasts([]);
  }, [timeoutRefs]);

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, removeToast, clearAllToasts }}
    >
      {children}
    </ToastContext.Provider>
  );
}
