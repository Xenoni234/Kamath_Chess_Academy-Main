"use client";

import { useSyncExternalStore } from "react";
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

/**
 * `<html data-theme>` is the source of truth: the no-flash script sets it before
 * React boots. Reading it through `useSyncExternalStore` keeps every toggle on
 * the page (sidebar and navbar render separate instances) showing the same
 * state, and gives hydration a server snapshot that cannot disagree.
 */
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** SSR and the hydration render both assume dark, matching the pre-script default. */
function readServerTheme(): Theme {
  return "dark";
}

export default function ThemeToggle({
  variant = "full",
  className = "",
}: {
  variant?: "full" | "icon";
  className?: string;
}) {
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, readServerTheme);

  function toggle() {
    // Writing the attribute notifies the observer, which re-renders every toggle.
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  const willSwitchToLight = theme === "dark";
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
