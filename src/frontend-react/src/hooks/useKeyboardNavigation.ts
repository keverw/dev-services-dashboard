import { useEffect } from "react";
import { ServiceConfig } from "../types";

interface UseKeyboardNavigationOptions {
  services: ServiceConfig[];
  activeTabId: string | null;
  onTabSwitch: (serviceId: string) => void;
}

export function useKeyboardNavigation({
  services,
  activeTabId,
  onTabSwitch,
}: UseKeyboardNavigationOptions) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Only handle if we have tabs and one is active
      if (!activeTabId || !services.length) return;

      const currentIndex = services.findIndex(
        (service) => service.id === activeTabId,
      );
      if (currentIndex === -1) return;

      // Check if a tab button is currently focused
      const activeElement = document.activeElement;
      if (!activeElement || !activeElement.classList.contains("tab-button")) {
        return;
      }

      // Left arrow: previous tab
      if (e.key === "ArrowLeft") {
        const prevIndex =
          (currentIndex - 1 + services.length) % services.length;
        const prevServiceId = services[prevIndex].id;
        onTabSwitch(prevServiceId);

        // Focus the previous tab button
        const prevTabButton = document.getElementById(`tab-${prevServiceId}`);
        if (prevTabButton) {
          prevTabButton.focus();
        }
        e.preventDefault();
      }

      // Right arrow: next tab
      if (e.key === "ArrowRight") {
        const nextIndex = (currentIndex + 1) % services.length;
        const nextServiceId = services[nextIndex].id;
        onTabSwitch(nextServiceId);

        // Focus the next tab button
        const nextTabButton = document.getElementById(`tab-${nextServiceId}`);
        if (nextTabButton) {
          nextTabButton.focus();
        }
        e.preventDefault();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [services, activeTabId, onTabSwitch]);
}
