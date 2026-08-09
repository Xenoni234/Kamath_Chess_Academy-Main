/**
 * Node-side Stockfish, used by report generation.
 *
 * Board analysis is not persisted (by design), so the report job cannot reuse
 * it and has to evaluate positions itself. Node exposes SharedArrayBuffer
 * natively, so the multi-threaded build works here without the COOP/COEP
 * headers the browser needs.
 *
 * The engine loaded is the same build the browser gets, from `public/engine/`
 * (put there by scripts/copyEngine.mjs at prebuild). We deliberately do *not*
 * `require("stockfish")`: that package is a devDependency, so it is absent
 * from a production install, whereas `public/` always ships with the app.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseBestMove, parseInfoLine, setOption } from "./uci";

const ENGINE_DIR = path.join(process.cwd(), "public", "engine");
const ENGINE_JS = path.join(ENGINE_DIR, "stockfish-18-lite.js");
const ENGINE_WASM = path.join(ENGINE_DIR, "stockfish-18-lite.wasm");

export type ServerScore = {
  cp: number | null;
  mate: number | null;
  bestMove: string;
};

export type AnalyzeBudget = {
  /** Search depth per position. */
  depth: number;
  /** Threads for the engine to use. */
  threads: number;
  /** Give up on the whole sweep after this long. */
  totalTimeoutMs: number;
};

export const DEFAULT_BUDGET: AnalyzeBudget = {
  depth: 12,
  threads: 2,
  totalTimeoutMs: 8 * 60 * 1000,
};

type EngineHandle = {
  listener?: (line: string) => void;
  sendCommand: (command: string) => void;
  terminate?: () => void;
};

/** The Emscripten module the engine file exports when required under Node. */
type EngineModule = {
  listener?: (line: string) => void;
  locateFile: (file: string) => string;
  ccall: (
    name: string,
    returnType: null,
    argTypes: string[],
    args: string[],
    options?: { async?: boolean },
  ) => void;
  terminate?: () => void;
  _isReady?: () => boolean;
};

/** Boot an engine instance and wait for `readyok`. */
async function createEngine(threads: number): Promise<EngineHandle> {
  // turbopackIgnore stops the bundler resolving (and trying to inline a 7 MB
  // engine) at build time — this path only exists at runtime. The engine file
  // is CommonJS, so its `module.exports` arrives as `default`.
  const engineUrl = pathToFileURL(ENGINE_JS).href;
  const loaded = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ engineUrl)) as {
    default: () => (module: Partial<EngineModule>) => Promise<void>;
  };
  const initEngine = loaded.default;

  const engineModule: Partial<EngineModule> = {
    // The loader asks for its own siblings by name; point it at public/engine.
    locateFile: (file: string) => (file.endsWith(".wasm") ? ENGINE_WASM : ENGINE_JS),
  };

  await initEngine()(engineModule);

  // Emscripten resolves its promise slightly before the engine accepts input.
  const ready = engineModule as EngineModule;
  for (let attempt = 0; ready._isReady && !ready._isReady() && attempt < 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const engine: EngineHandle = {
    sendCommand: (command: string) => {
      ready.ccall("command", null, ["string"], [command], { async: /^go\b/.test(command) });
    },
    terminate: () => ready.terminate?.(),
  };

  // `listener` lives on the module; mirror assignments through to it.
  Object.defineProperty(engine, "listener", {
    get: () => ready.listener,
    set: (value: ((line: string) => void) | undefined) => {
      ready.listener = value;
    },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("engine handshake timed out")), 30_000);
    engine.listener = (line: string) => {
      if (line === "readyok") {
        clearTimeout(timer);
        engine.listener = undefined;
        resolve();
      }
    };
    engine.sendCommand("uci");
    engine.sendCommand(setOption("Threads", threads));
    engine.sendCommand(setOption("Hash", 128));
    engine.sendCommand("isready");
  });

  return engine;
}

function searchPosition(
  engine: EngineHandle,
  fen: string,
  depth: number,
  timeoutMs: number,
): Promise<ServerScore> {
  return new Promise((resolve) => {
    let cp: number | null = null;
    let mate: number | null = null;
    let settled = false;

    const finish = (bestMove: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      engine.listener = undefined;
      resolve({ cp, mate, bestMove });
    };

    // A hung search must not stall the whole report.
    const timer = setTimeout(() => {
      engine.sendCommand("stop");
      finish("");
    }, timeoutMs);

    engine.listener = (line: string) => {
      const info = parseInfoLine(line, fen);
      if (info && info.multipv === 1) {
        cp = info.cp;
        mate = info.mate;
        return;
      }

      const best = parseBestMove(line);
      if (best) finish(best.bestMove === "(none)" ? "" : best.bestMove);
    };

    engine.sendCommand(`position fen ${fen}`);
    engine.sendCommand(`go depth ${depth}`);
  });
}

/**
 * Evaluate a list of positions in order.
 *
 * Returns as many scores as it managed within the budget — callers must handle
 * a short array rather than assuming one score per input.
 */
export async function analyzePositions(
  fens: string[],
  budget: AnalyzeBudget = DEFAULT_BUDGET,
): Promise<ServerScore[]> {
  if (fens.length === 0) return [];

  const scores: ServerScore[] = [];
  let engine: EngineHandle | null = null;
  const deadline = Date.now() + budget.totalTimeoutMs;

  try {
    engine = await createEngine(budget.threads);
    engine.sendCommand("ucinewgame");

    for (const fen of fens) {
      if (Date.now() > deadline) {
        console.warn(
          `[serverEngine] budget exhausted after ${scores.length}/${fens.length} positions`,
        );
        break;
      }

      const remaining = Math.max(1000, deadline - Date.now());
      scores.push(await searchPosition(engine, fen, budget.depth, Math.min(20_000, remaining)));
    }

    return scores;
  } catch (error) {
    console.error("[serverEngine] analysis failed:", error);
    return scores;
  } finally {
    try {
      engine?.sendCommand("quit");
      engine?.terminate?.();
    } catch {
      // The worker may already be gone; nothing useful to do here.
    }
  }
}
