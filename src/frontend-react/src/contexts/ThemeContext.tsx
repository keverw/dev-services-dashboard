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

  // The actual theme value is derived from mode + system theme, so no separate
  // state needed (deriving avoids a setState-in-effect cascade).
  const theme: ThemeValue = mode === "auto" ? systemTheme : mode;

  // Apply the resolved theme to the document for Tailwind dark mode.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Persist the chosen mode.
  useEffect(() => {
    localStorage.setItem("dev-services-dashboard-theme-mode", mode);
  }, [mode]);

  // Enable color transitions only after the first paint, so the theme applied
  // on initial load snaps in rather than animating from the default.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-transitions");
    });
    return () => cancelAnimationFrame(id);
  }, []);

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
