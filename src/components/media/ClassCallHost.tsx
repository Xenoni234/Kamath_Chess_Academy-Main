"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Maximize2, PhoneOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Keeps a live class running while the coach moves around the site.
 *
 * The class room used to own the Jitsi iframe. Navigating anywhere — to show a student a
 * position on the analysis board, which is the entire point of a chess lesson — unmounted
 * the page, disposed the API, and **ended the meeting for everyone**. The coach could
 * share their screen, or use the site they were teaching from, but not both.
 *
 * The fix has one hard constraint: **an iframe reloads when it is re-parented.** Moving
 * the call into a floating window with `appendChild` would drop the call every time, which
 * is the same bug wearing a different hat. So the iframe is created ONCE, inside a
 * `position: fixed` host mounted above every dashboard page, and it never moves in the DOM
 * at all. Only its CSS box changes:
 *
 *   - on the class room page, the page publishes the rectangle of its video slot and the
 *     host lines itself up with it, so it looks embedded;
 *   - anywhere else, the host shrinks to a corner and becomes a small always-on window
 *     with a way back and a way out.
 *
 * Nothing unmounts, so nothing reconnects, so the screen share survives.
 */

export type CallRequest = {
  classId: string;
  classTitle: string;
  roomKey: string;
  displayName: string;
  jaas: { appId: string | null; room: string; token: string | null } | null;
};

type CallContextValue = {
  active: CallRequest | null;
  startCall: (request: CallRequest) => void;
  /** Hang up for this viewer. Does not end the meeting for anyone else. */
  endCall: () => void;
  /** The room page publishes where its video slot is; null means "not on that page". */
  setAnchor: (rect: DOMRect | null) => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useClassCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useClassCall must be used inside ClassCallHost");
  return ctx;
}

const MINI = { width: 320, height: 200, margin: 16 };

export default function ClassCallHost({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<CallRequest | null>(null);
  const [anchor, setAnchorState] = useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ dispose: () => void } | null>(null);

  const setAnchor = useCallback((rect: DOMRect | null) => {
    // Compare before setting: a ResizeObserver fires continuously during a window drag,
    // and re-rendering the host every frame would fight the video for the main thread.
    setAnchorState((prev) => {
      if (!prev && !rect) return prev;
      if (
        prev &&
        rect &&
        Math.abs(prev.top - rect.top) < 1 &&
        Math.abs(prev.left - rect.left) < 1 &&
        Math.abs(prev.width - rect.width) < 1 &&
        Math.abs(prev.height - rect.height) < 1
      ) {
        return prev;
      }
      return rect;
    });
  }, []);

  const startCall = useCallback((request: CallRequest) => {
    // Adopting an already-running call is the whole point: re-entering the room while the
    // mini window is up must NOT tear down and rejoin.
    setActive((prev) => (prev && prev.classId === request.classId ? prev : request));
  }, []);

  const endCall = useCallback(() => {
    apiRef.current?.dispose();
    apiRef.current = null;
    setActive(null);
    setAnchorState(null);
  }, []);

  // Create the meeting exactly once per class, and never again until it ends.
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const parentNode = containerRef.current;
    const call = active;
    let cancelled = false;

    const useJaas = Boolean(call.jaas?.token && call.jaas.appId);
    const SCRIPT_ID = "jitsi-external-api";
    const scriptSrc = useJaas
      ? `https://8x8.vc/${call.jaas!.appId}/external_api.js`
      : "https://meet.jit.si/external_api.js";

    function start() {
      const Ctor = (
        window as unknown as {
          JitsiMeetExternalAPI?: new (domain: string, options: unknown) => { dispose: () => void };
        }
      ).JitsiMeetExternalAPI;
      if (cancelled || !Ctor || apiRef.current) return;

      apiRef.current = new Ctor(useJaas ? "8x8.vc" : "meet.jit.si", {
        roomName: useJaas ? call.jaas!.room : `KCA-${call.roomKey}`,
        ...(useJaas ? { jwt: call.jaas!.token } : {}),
        parentNode,
        width: "100%",
        height: "100%",
        // Never in the URL — a child's name does not belong in browser history.
        userInfo: { displayName: call.displayName },
        configOverwrite: { prejoinPageEnabled: false, startWithAudioMuted: true },
      });
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if ((window as unknown as { JitsiMeetExternalAPI?: unknown }).JitsiMeetExternalAPI) start();
      else existing.addEventListener("load", start, { once: true });
    } else {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = scriptSrc;
      script.async = true;
      script.onload = start;
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
      // Deliberately NOT disposing. This cleanup runs whenever `active` changes identity,
      // and disposing here would drop a call that is meant to outlive navigation.
      // `endCall` is the only thing that hangs up.
    };
  }, [active]);

  const docked = Boolean(anchor);
  const style: React.CSSProperties = anchor
    ? { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height }
    : { bottom: MINI.margin, right: MINI.margin, width: MINI.width, height: MINI.height };

  return (
    <CallContext.Provider value={{ active, startCall, endCall, setAnchor }}>
      {children}

      {/* One host, always fixed, never re-parented. Hidden rather than unmounted when no
          call is running, so the container element itself stays stable. */}
      <div
        className={cn(
          "fixed z-[80] overflow-hidden bg-black transition-all duration-200",
          docked ? "rounded-xl" : "rounded-xl border border-kca-cyan shadow-cyan-md",
        )}
        style={style}
        hidden={!active}
      >
        <div ref={containerRef} className="h-full w-full" />

        {/* The floating state needs a way back and a way out. Docked, the page's own
            controls are right there and this bar would only be clutter. */}
        {!docked && active && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-kca-black/85 px-2 py-1.5 backdrop-blur-sm">
            <span className="truncate text-[11px] font-semibold text-kca-white">
              {active.classTitle}
            </span>
            <Link
              href={`/dashboard/classes/${active.classId}/room`}
              aria-label="Back to the class"
              className="ml-auto rounded p-1 text-kca-cyan hover:bg-kca-surface-2"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Link>
            <button
              type="button"
              onClick={endCall}
              aria-label="Leave the class"
              className="rounded p-1 text-kca-danger hover:bg-kca-surface-2"
            >
              <PhoneOff className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </CallContext.Provider>
  );
}

/**
 * Publishes this element's rectangle to the host, so the fixed call lines up with it and
 * reads as embedded. Clears it on unmount, which is what turns the call into the mini
 * window when the coach navigates away.
 */
export function useCallAnchor(enabled: boolean) {
  const { setAnchor } = useClassCall();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    const publish = () => setAnchor(el.getBoundingClientRect());
    publish();

    const observer = new ResizeObserver(publish);
    observer.observe(el);
    // `true` for capture: the page scrolls inside <main>, not the window.
    window.addEventListener("scroll", publish, true);
    window.addEventListener("resize", publish);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", publish, true);
      window.removeEventListener("resize", publish);
      setAnchor(null);
    };
  }, [enabled, setAnchor]);

  return ref;
}
