import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from "react";

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning" | "info";
  duration?: number;
  // True while the toast is playing its exit animation, just before unmount.
  exiting?: boolean;
}

interface ToastContextType {
  toasts: Toast[];
  // Returns the new toast's id so callers can update it later (e.g. a live
  // progress toast). Pass `duration: 0` to keep it on screen until removed.
  addToast: (toast: Omit<Toast, "id" | "exiting">) => string;
  updateToast: (
    id: string,
    updates: Partial<Omit<Toast, "id" | "exiting">>,
  ) => void;
  removeToast: (id: string) => void;
  clearAllToasts: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const MAX_TOASTS = 6;

// Keep in sync with the toastSlideOut animation duration in index.css.
const EXIT_ANIMATION_MS = 400;

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
  // Tracks the delay between starting a toast's exit animation and unmounting
  // it, so we can guard against scheduling the same exit twice.
  const removalTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  // Begin the exit animation for a toast, then unmount it once the animation
  // has finished. Idempotent — a toast already exiting is left alone.
  const removeToast = useCallback((id: string) => {
    if (removalTimers.current.has(id)) return;

    setToasts((prev) =>
      prev.map((toast) =>
        toast.id === id ? { ...toast, exiting: true } : toast,
      ),
    );

    const timer = setTimeout(() => {
      removalTimers.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, EXIT_ANIMATION_MS);

    removalTimers.current.set(id, timer);
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, "id" | "exiting">) => {
      const id = Math.random().toString(36).substr(2, 9);

      let defaultDuration = 4000;
      if (
        toast.type === "success" &&
        toast.message.includes("started successfully")
      ) {
        defaultDuration = 2500;
      } else if (toast.type === "info" && toast.message.includes("Starting")) {
        defaultDuration = 3000;
      } else if (toast.type === "warning") {
        defaultDuration = 5000;
      } else if (toast.type === "error") {
        defaultDuration = 6000;
      }

      // `duration: 0` means "sticky" — stays until explicitly removed.
      const duration = toast.duration ?? defaultDuration;
      const newToast: Toast = { ...toast, id, duration };

      setToasts((prev) => {
        const next = [newToast, ...prev];

        // Cap the number of *dismissable* toasts on screen, animating out the
        // oldest extras instead of dropping them abruptly. Sticky toasts
        // (duration 0, e.g. a live progress toast) are never evicted — they
        // stay until explicitly removed. Deferred so we don't call setState
        // from within this updater.
        const evictable = next.filter(
          (t) => !t.exiting && (t.duration ?? 0) > 0,
        );

        if (evictable.length > MAX_TOASTS) {
          const overflow = evictable.slice(MAX_TOASTS);
          queueMicrotask(() => overflow.forEach((t) => removeToast(t.id)));
        }

        return next;
      });

      // Auto-dismiss (through the exit animation) once the duration elapses.
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }

      return id;
    },
    [removeToast],
  );

  const updateToast = useCallback(
    (id: string, updates: Partial<Omit<Toast, "id" | "exiting">>) => {
      setToasts((prev) =>
        prev.map((toast) =>
          toast.id === id ? { ...toast, ...updates } : toast,
        ),
      );
    },
    [],
  );

  const clearAllToasts = useCallback(() => {
    removalTimers.current.forEach((timer) => clearTimeout(timer));
    removalTimers.current.clear();
    setToasts([]);
  }, []);

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, updateToast, removeToast, clearAllToasts }}
    >
      {children}
    </ToastContext.Provider>
  );
}
