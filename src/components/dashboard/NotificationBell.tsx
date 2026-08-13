"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, Check } from "lucide-react";
import { getSocket } from "@/lib/socket/client";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export default function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await fetch("/api/notifications");
      const data = await res.json();
      if (data.success) {
        setItems(data.notifications);
        setUnread(data.unread);
      }
    } catch {
      // Non-fatal; the bell just shows the last state.
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(load, 30_000);
    const socket = getSocket();
    socket.on("notification:new", (n: Notification) => {
      setItems((prev) => [n, ...prev].slice(0, 30));
      setUnread((u) => u + 1);
    });
    return () => {
      clearInterval(interval);
      socket.off("notification:new");
    };
  }, []);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    } catch {
      // Optimistic — the next poll reconciles.
    }
  }

  async function markAll() {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
    } catch {
      // Optimistic.
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="flex w-full items-center gap-3 rounded-lg border border-kca-border px-4 py-2.5 text-sm font-semibold text-kca-gray-400 transition-colors hover:bg-kca-surface-2 hover:text-kca-white"
      >
        <Bell className="h-4 w-4 text-kca-cyan" />
        Notifications
        {unread > 0 && (
          <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-kca-cyan px-1.5 text-[11px] font-bold text-kca-black">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 max-h-96 w-72 overflow-y-auto rounded-xl border border-kca-border bg-kca-surface shadow-cyan-md">
          <div className="sticky top-0 flex items-center justify-between border-b border-kca-border bg-kca-surface px-4 py-2.5">
            <span className="text-xs font-bold uppercase tracking-wider text-kca-gray-400">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="flex items-center gap-1 text-[11px] text-kca-cyan hover:underline">
                <Check className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-kca-gray-400">No notifications yet.</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                onClick={() => markRead(n.id)}
                className={cn(
                  "block w-full border-b border-kca-border/50 px-4 py-3 text-left transition-colors hover:bg-kca-surface-2",
                  !n.readAt && "bg-kca-cyan/5",
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      n.readAt ? "bg-transparent" : "bg-kca-cyan",
                    )}
                  />
                  <div>
                    <div className="text-sm font-semibold text-kca-white">{n.title}</div>
                    <div className="mt-0.5 text-xs text-kca-gray-400">{n.body}</div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
