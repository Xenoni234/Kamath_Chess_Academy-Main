"use client";

import { useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";

type GameClockProps = {
  timeMs: number;
  isActive: boolean;
  format?: string;
};

export default function GameClock({ timeMs, isActive, format }: GameClockProps) {
  const [localTime, setLocalTime] = useState(timeMs);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync internal state when server updates timeMs
  useEffect(() => {
    setLocalTime(timeMs);
  }, [timeMs]);

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
