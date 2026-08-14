"use client";

import { useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";

type GameClockProps = {
  timeMs: number;
  isActive: boolean;
  format?: string;
  onExpire?: () => void;
};

// `format` is accepted for call-site symmetry with the other clock props but is
// not rendered — the display format is derived from `timeMs`.
export default function GameClock({ timeMs, isActive, onExpire }: GameClockProps) {
  const [localTime, setLocalTime] = useState(timeMs);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const expiredRef = useRef(false);

  // The server pushes an authoritative `timeMs` that overrides the local
  // countdown. Adjusting during render rather than in an effect means the new
  // value is shown on the first render after it arrives, with no stale frame in
  // between. See react.dev — "adjusting some state when a prop changes".
  const [syncedTimeMs, setSyncedTimeMs] = useState(timeMs);
  if (timeMs !== syncedTimeMs) {
    setSyncedTimeMs(timeMs);
    setLocalTime(timeMs);
  }

  // Fire once when this clock runs out while active. The server re-validates
  // the real remaining time before ending the game, so this is only a trigger.
  useEffect(() => {
    if (isActive && localTime <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      onExpire?.();
    }
    if (localTime > 0) {
      expiredRef.current = false;
    }
  }, [isActive, localTime, onExpire]);

  // Handle countdown interval
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (isActive && localTime > 0) {
      timerRef.current = setInterval(() => {
        setLocalTime((prev) => {
          const next = prev - 100;
          if (next <= 0) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return next;
        });
      }, 100);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isActive, localTime]);

  const formatTime = (ms: number) => {
    if (ms <= 0) return "00:00";

    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (num: number) => String(num).padStart(2, "0");

    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
  };

  // Determine text color and styling based on remaining time
  const isDanger = localTime < 10000;  // under 10 seconds
  const isWarning = localTime < 30000 && localTime >= 10000; // under 30 seconds

  return (
    <div
      className={cn(
        "px-4 py-2 rounded-lg font-mono text-xl font-bold transition-all duration-300 border",
        isActive
          ? "bg-kca-surface-3 border-kca-cyan shadow-cyan-sm scale-[1.03]"
          : "bg-kca-surface border-kca-border opacity-70"
      )}
    >
      <span
        className={cn(
          "transition-colors duration-300",
          isDanger
            ? "text-kca-danger animate-pulse"
            : isWarning
            ? "text-kca-warning"
            : "text-kca-white"
        )}
      >
        {formatTime(localTime)}
      </span>
    </div>
  );
}
