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

export type MultiPvMove = {
  /** The move in UCI (e2e4). */
  uci: string;
  /** Centipawns, White's point of view. Null when mate is set. */
  cp: number | null;
  /** Moves to mate, White's point of view. */
  mate: number | null;
};

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
  threads: 1,
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

/**
 * The real `fetch`, captured at module load — before any engine has booted.
 *
 * The Emscripten runtime clobbers `globalThis.fetch` while it boots. Saving it
 * per-boot is only safe when boots are serialised: with a pool, engine B can
 * capture the *already clobbered* fetch that engine A has not restored yet, and
 * then faithfully restore the broken one. Everything downstream (the opening
 * explorer, Upstash, the AI narrative) then dies with "fetch is not a function".
 * Anchoring to the pristine reference removes the ordering question entirely.
 */
const PRISTINE_FETCH = globalThis.fetch;

/**
 * Boots are serialised. Emscripten module init touches process-global state, and
 * a pool would otherwise interleave several inits. Each boot is ~300ms, so even
 * eight cost ~2.4s once — negligible against the search work they then do.
 */
let bootQueue: Promise<unknown> = Promise.resolve();

/** Boot an engine instance and wait for `readyok`. */
function createEngine(threads: number): Promise<EngineHandle> {
  const next = bootQueue.then(() => bootEngine(threads));
  // Keep the chain alive even if this boot rejects.
  bootQueue = next.catch(() => {});
  return next;
}

async function bootEngine(threads: number): Promise<EngineHandle> {
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

  // The Emscripten runtime clobbers the global `fetch` while it boots (it wires
  // up its own for browser asset loading). That would break every fetch the
  // profiling worker makes *after* the engine runs — the opening explorer,
  // Upstash Redis, the AI narrative. Restore the reference captured at module
  // load, never whatever happens to be installed now.
  await initEngine()(engineModule);
  if (globalThis.fetch !== PRISTINE_FETCH) {
    globalThis.fetch = PRISTINE_FETCH;
  }

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

/**
 * How long to keep listening after `stop` before giving up on a `bestmove`.
 *
 * `stop` always makes the engine emit one, usually within milliseconds. This
 * grace only exists for a genuinely wedged engine.
 */
const STOP_GRACE_MS = 5_000;

/** Warn when a search takes far longer than its depth should need. */
const SLOW_SEARCH_LOG_MS = 10_000;

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
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const finish = (bestMove: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      engine.listener = undefined;
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_SEARCH_LOG_MS) {
        console.warn(`[serverEngine] slow search: ${elapsed}ms at depth ${depth}`);
      }
      resolve({ cp, mate, bestMove });
    };

    // A hung search must not stall the whole report — but we must NOT abandon
    // the listener here. `stop` produces a `bestmove` asynchronously; resolving
    // before it arrives leaves that message to be picked up by the *next*
    // search's listener, which then resolves the wrong position (and every
    // search after it) with a stale result. Keep listening until it lands.
    const timer = setTimeout(() => {
      engine.sendCommand("stop");
      graceTimer = setTimeout(() => finish(""), STOP_GRACE_MS);
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

/** A search result that keeps the whole principal variation, not just its head. */
export type PvResult = {
  /** Best move in UCI, or "" when the search produced nothing. */
  bestMove: string;
  cp: number | null;
  mate: number | null;
  /** Full PV in UCI, deepest snapshot seen. First entry equals `bestMove`. */
  pv: string[];
};

/**
 * Like `searchPosition`, but keeps `info.pv`.
 *
 * The engine already computes a whole principal variation on every search and
 * the other helpers here throw it away. Keeping it means one search can supply
 * a dozen plies of continuation instead of a single move — which is what makes
 * long repertoire lines affordable.
 */
function searchPositionWithPv(
  engine: EngineHandle,
  fen: string,
  depth: number,
  timeoutMs: number,
): Promise<PvResult> {
  return new Promise((resolve) => {
    let cp: number | null = null;
    let mate: number | null = null;
    let pv: string[] = [];
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const finish = (bestMove: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      engine.listener = undefined;
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_SEARCH_LOG_MS) {
        console.warn(`[serverEngine] slow PV search: ${elapsed}ms at depth ${depth}`);
      }
      resolve({ bestMove, cp, mate, pv });
    };

    // See `searchPosition`: keep listening after `stop` so the `bestmove` it
    // produces is consumed here rather than by the next search.
    const timer = setTimeout(() => {
      engine.sendCommand("stop");
      graceTimer = setTimeout(() => finish(pv[0] ?? ""), STOP_GRACE_MS);
    }, timeoutMs);

    engine.listener = (line: string) => {
      const info = parseInfoLine(line, fen);
      if (info && info.multipv === 1 && info.pv.length > 0) {
        cp = info.cp;
        mate = info.mate;
        pv = info.pv;
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
 * Default fan-out for batch engine work.
 *
 * Measured on this hardware: for FIXED-DEPTH searches, more threads per engine
 * is *slower* — SMP widens the search, so nodes-to-depth grows faster than nps
 * (depth 20: 1311ms at threads=1 versus 1762ms at threads=4). Throughput comes
 * from running many single-threaded engines instead, which scales close to
 * linearly. Leaving 2 cores free keeps the web server responsive while a
 * dossier generates.
 */
export const ENGINE_CONCURRENCY = 8;

/**
 * Run `worker` over `items` across a pool of single-threaded engines.
 *
 * Each worker gets its own engine and therefore its own transposition table, so
 * items that share an opening tree still benefit within a worker. Results keep
 * the order of `items`. A failing item does not sink the batch — it resolves as
 * `null` and the caller decides.
 */
export async function mapWithEngines<T, R>(
  items: T[],
  worker: (item: T, search: (fen: string, depth: number) => Promise<PvResult>) => Promise<R>,
  options: { concurrency?: number; threads?: number; totalTimeoutMs?: number } = {},
): Promise<(R | null)[]> {
  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(options.concurrency ?? ENGINE_CONCURRENCY, items.length));
  const threads = options.threads ?? 1;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_BUDGET.totalTimeoutMs;
  const deadline = Date.now() + totalTimeoutMs;

  const results: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;

  const runOne = async () => {
    let engine: EngineHandle | null = null;
    try {
      engine = await createEngine(threads);
      engine.sendCommand("ucinewgame");
      const handle = engine;

      // `cursor++` is safe: JS is single-threaded, so no two workers can claim
      // the same index.
      for (let index = cursor++; index < items.length; index = cursor++) {
        if (Date.now() > deadline) break;
        try {
          results[index] = await worker(items[index], async (fen, depth) => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return { bestMove: "", cp: null, mate: null, pv: [] };
            return searchPositionWithPv(
              handle,
              fen,
              depth,
              Math.min(60_000, Math.max(1000, remaining)),
            );
          });
        } catch (error) {
          console.error(`[serverEngine] item ${index} failed:`, error);
        }
      }
    } finally {
      try {
        engine?.sendCommand("quit");
        engine?.terminate?.();
      } catch {
        // The worker may already be gone; nothing useful to do here.
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, runOne));
  return results;
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

/** Collect the top `multiPv` moves for one position, ranked best-first. */
function searchPositionMultiPV(
  engine: EngineHandle,
  fen: string,
  depth: number,
  multiPv: number,
  timeoutMs: number,
): Promise<MultiPvMove[]> {
  return new Promise((resolve) => {
    // Keep the latest line seen for each multipv index; the last snapshot before
    // `bestmove` is the deepest one.
    const lines = new Map<number, MultiPvMove>();
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      engine.listener = undefined;
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_SEARCH_LOG_MS) {
        console.warn(`[serverEngine] slow MultiPV search: ${elapsed}ms at depth ${depth}`);
      }
      resolve(
        [...lines.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, move]) => move),
      );
    };

    // See `searchPosition`: keep listening after `stop` so the `bestmove` it
    // produces is consumed here rather than by the next search.
    const timer = setTimeout(() => {
      engine.sendCommand("stop");
      graceTimer = setTimeout(finish, STOP_GRACE_MS);
    }, timeoutMs);

    engine.listener = (line: string) => {
      const info = parseInfoLine(line, fen);
      if (info && info.pv.length > 0 && info.multipv <= multiPv) {
        lines.set(info.multipv, { uci: info.pv[0], cp: info.cp, mate: info.mate });
        return;
      }
      if (parseBestMove(line)) finish();
    };

    engine.sendCommand(`position fen ${fen}`);
    engine.sendCommand(`go depth ${depth}`);
  });
}

/**
 * Evaluate positions returning the engine's top-N moves each (for novelty
 * mining). Same budget/short-array contract as analyzePositions.
 */
export async function analyzePositionsMultiPV(
  fens: string[],
  options: { depth?: number; threads?: number; multiPv?: number; totalTimeoutMs?: number } = {},
): Promise<MultiPvMove[][]> {
  if (fens.length === 0) return [];

  const depth = options.depth ?? 14;
  const threads = options.threads ?? DEFAULT_BUDGET.threads;
  const multiPv = options.multiPv ?? 3;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_BUDGET.totalTimeoutMs;

  const results: MultiPvMove[][] = [];
  let engine: EngineHandle | null = null;
  const deadline = Date.now() + totalTimeoutMs;

  try {
    engine = await createEngine(threads);
    engine.sendCommand(setOption("MultiPV", multiPv));
    engine.sendCommand("ucinewgame");

    for (const fen of fens) {
      if (Date.now() > deadline) {
        console.warn(
          `[serverEngine] MultiPV budget exhausted after ${results.length}/${fens.length} positions`,
        );
        break;
      }
      const remaining = Math.max(1000, deadline - Date.now());
      results.push(await searchPositionMultiPV(engine, fen, depth, multiPv, Math.min(20_000, remaining)));
    }

    return results;
  } catch (error) {
    console.error("[serverEngine] MultiPV analysis failed:", error);
    return results;
  } finally {
    try {
      engine?.sendCommand("quit");
      engine?.terminate?.();
    } catch {
      // Worker may already be gone.
    }
  }
}
