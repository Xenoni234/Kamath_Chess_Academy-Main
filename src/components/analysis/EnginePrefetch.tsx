"use client";

import { useEffect } from "react";
import { selectEngine } from "@/lib/engine/select";

/**
 * Warm the Stockfish download while the student is busy doing something else.
 *
 * The engine is 6.8 MB of WASM (5.5 MB gzipped, measured against production). With the
 * year-long cache now set in `next.config.ts` it is paid for once — but the FIRST time is
 * still a cold ten-to-thirty seconds on mobile data, and it lands exactly when the student
 * clicks "Look at this position" and is waiting on it.
 *
 * Solving a puzzle takes far longer than the download. Fetching it in the background while
 * they think turns that wait into no wait at all, and costs nothing when the file is
 * already cached — the browser serves the prefetch from cache too.
 *
 * `requestIdleCallback` so this never competes with rendering the page it sits on.
 */
export default function EnginePrefetch() {
  useEffect(() => {
    const schedule =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 1500);

    const handle = schedule(() => {
      const { url } = selectEngine();
      // The loader resolves its .wasm sibling from its own URL, so fetching both is what
      // the engine will actually ask for.
      const wasm = url.replace(/\.js$/, ".wasm");
      for (const href of [url, wasm]) {
        // A plain fetch rather than <link rel=prefetch>: Safari ignores prefetch for
        // cross-origin-isolated documents, and this fills the same HTTP cache.
        void fetch(href, { cache: "force-cache" }).catch(() => {
          // Offline, or the file moved. The analysis page will fetch it normally.
        });
      }
    });

    return () => {
      if (typeof window.cancelIdleCallback === "function" && typeof handle === "number") {
        window.cancelIdleCallback(handle);
      }
    };
  }, []);

  return null;
}
