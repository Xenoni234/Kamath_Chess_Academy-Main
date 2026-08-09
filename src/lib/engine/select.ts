/**
 * Picks which Stockfish build the browser should load.
 *
 * The files come from scripts/copyEngine.mjs. Each loader resolves its `.wasm`
 * sibling from its own URL, so both flavours live in /engine/.
 *
 * The multi-threaded build needs SharedArrayBuffer, which requires the page to
 * be cross-origin isolated (COOP/COEP are set in server.mjs). If isolation is
 * missing — an older browser, or a deployment that drops the headers — we fall
 * back rather than failing, so analysis still works, just slower.
 */
export type EngineFlavor = "wasm-mt" | "wasm-st" | "asm";

export type EngineChoice = {
  url: string;
  flavor: EngineFlavor;
  supportsThreads: boolean;
  label: string;
};

const WASM_MT: EngineChoice = {
  url: "/engine/stockfish-18-lite.js",
  flavor: "wasm-mt",
  supportsThreads: true,
  label: "Stockfish 18 Lite (multi-threaded)",
};

const WASM_ST: EngineChoice = {
  url: "/engine/stockfish-18-lite-single.js",
  flavor: "wasm-st",
  supportsThreads: false,
  label: "Stockfish 18 Lite (single-threaded)",
};

/** Stockfish 10 asm.js, kept from Phase 2's first pass as a last resort. */
const ASM: EngineChoice = {
  url: "/stockfish.js",
  flavor: "asm",
  supportsThreads: false,
  label: "Stockfish 10 (asm.js fallback)",
};

function hasWasm(): boolean {
  return (
    typeof WebAssembly === "object" &&
    typeof WebAssembly.validate === "function" &&
    WebAssembly.validate(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))
  );
}

function isCrossOriginIsolated(): boolean {
  return (
    typeof SharedArrayBuffer === "function" &&
    typeof globalThis.crossOriginIsolated === "boolean" &&
    globalThis.crossOriginIsolated
  );
}

export function selectEngine(): EngineChoice {
  if (!hasWasm()) return ASM;
  return isCrossOriginIsolated() ? WASM_MT : WASM_ST;
}

/** Threads to request from a multi-threaded build. Capped — more hurts on lite. */
export function defaultThreads(): number {
  const cores = typeof navigator === "undefined" ? 2 : (navigator.hardwareConcurrency ?? 2);
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 1));
}
