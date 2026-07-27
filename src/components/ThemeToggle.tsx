"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";

const STORAGE_KEY = "kca-theme";

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private mode, disabled cookies, etc.).
  }
}

export default function ThemeToggle({
  variant = "full",
  className = "",
}: {
  variant?: "full" | "icon";
  className?: string;
}) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  // Read the theme the no-flash script already applied to <html>.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  // Until mounted, assume dark so SSR and first client render match.
  const willSwitchToLight = !mounted || theme === "dark";
  const label = willSwitchToLight ? "Switch to light mode" : "Switch to dark mode";
  const Icon = willSwitchToLight ? Sun : Moon;

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        className={`flex h-10 w-10 items-center justify-center rounded-lg border border-kca-border text-kca-white transition-colors hover:border-kca-cyan hover:text-kca-cyan ${className}`}
      >
        <Icon className="h-5 w-5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      className={`btn-secondary w-full ${className}`}
    >
      <Icon className="h-5 w-5" />
      {willSwitchToLight ? "Light Mode" : "Dark Mode"}
    </button>
  );
}
