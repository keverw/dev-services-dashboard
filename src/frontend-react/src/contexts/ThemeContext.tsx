import React, { createContext, useContext, useEffect, useState } from "react";

type ThemeMode = "auto" | "light" | "dark";
type ThemeValue = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  theme: ThemeValue;
  cycleTheme: () => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ThemeValue {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Store the system theme separately
  const [systemTheme, setSystemTheme] = useState<ThemeValue>(getSystemTheme());

  // Initialize theme mode from localStorage or default to 'auto'
  const [mode, setMode] = useState<ThemeMode>(() => {
    return (
      (localStorage.getItem(
        "dev-services-dashboard-theme-mode",
      ) as ThemeMode) || "auto"
    );
  });

  // Calculate actual theme value based on mode and system theme
  const [theme, setTheme] = useState<ThemeValue>(() => {
    return mode === "auto" ? systemTheme : mode;
  });

  // Update theme when mode or system theme changes
  useEffect(() => {
    const newTheme = mode === "auto" ? systemTheme : mode;
    setTheme(newTheme);

    // Update HTML class for Tailwind dark mode
    document.documentElement.classList.toggle("dark", newTheme === "dark");

    localStorage.setItem("dev-services-dashboard-theme-mode", mode);
  }, [mode, systemTheme]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      setSystemTheme(getSystemTheme());
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const cycleTheme = () => {
    setMode((current) => {
      const modes: ThemeMode[] = ["auto", "light", "dark"];
      const currentIndex = modes.indexOf(current);
      return modes[(currentIndex + 1) % modes.length];
    });
  };

  const value = { mode, theme, cycleTheme, setMode };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
