import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        /**
         * The Stockfish build is 6.8 MB of WASM, and Next serves everything in `public/`
         * with `Cache-Control: public, max-age=0`. That meant the browser re-fetched or
         * re-validated **5.5 MB on every single analysis page load** — measured against
         * production. On a laptop that is a second; on a student's phone on mobile data it
         * is ten to thirty, which is exactly the "puzzle analysis takes too long to load"
         * report. The engine is the same bytes every time, so paying for them once is the
         * whole fix.
         *
         * CONSTRAINT, and it is a real one: these filenames carry only the MAJOR version
         * (`stockfish-18-lite.wasm`), so a client that has cached them will keep them for a
         * year. If you ever upgrade Stockfish, you MUST change the filename — bump it to
         * `stockfish-19-...`, or add a hash in `scripts/copyEngine.mjs`. Shipping new
         * engine bytes under an old name will reach nobody who has already visited.
         */
        source: "/engine/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // The Phase 2 asm.js fallback, same reasoning and same constraint.
        source: "/stockfish.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
