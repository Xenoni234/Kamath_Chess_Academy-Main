"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  parseBestMove,
  parseInfoLine,
  setOption,
  type EngineLine,
} from "@/lib/engine/uci";
import { defaultThreads, selectEngine, type EngineFlavor } from "@/lib/engine/select";

/**
 * Stable no-op subscribe for the hydration probe below. The value never changes
 * after the first client render so there is nothing to listen to, but the
 * function identity must be stable or React resubscribes on every render.
 */
const subscribeNever = () => () => {};

export type AnalyzeRequest = {
  fen: string;
  /** Search to a fixed depth. Ignored when `movetimeMs` is set. */
  depth?: number;
  /** Search for a fixed wall-clock time instead of a depth. */
  movetimeMs?: number;
  multipv?: number;
};

export type AnalyzeResult = {
  fen: string;
  bestMove: string;
  lines: EngineLine[];
  depth: number;
};

export type StrengthOptions = {
  /** 0-20. Lower makes the engine deliberately choose weaker moves. */
  skillLevel?: number;
  /** Approximate target rating. Null disables UCI_LimitStrength. */
  elo?: number | null;
};

export type UseStockfishOptions = StrengthOptions & {
  multipv?: number;
  hashMb?: number;
  /** Skip creating the worker — useful while a page is still deciding. */
  enabled?: boolean;
};

type Task = {
  fen: string;
  go: string;
  multipv: number;
  /**
   * "infinite" backs the board's live evaluation and is abandoned freely;
   * "search" is a bounded request someone is awaiting. Keeping them apart lets
   * `stopInfinite()` tear down the live search without killing a scan.
   */
  kind: "infinite" | "search";
  settle: (result: AnalyzeResult) => void;
};

const LINE_UPDATE_INTERVAL_MS = 120;

/**
 * Upper bound on a single bounded search. Generous — a depth-16 MultiPV-3
 * search is normally well under a second, and the full-game scan runs many in
 * sequence — but a search that never reports `bestmove` must not hang whatever
 * is awaiting it.
 */
const SEARCH_TIMEOUT_MS = 30_000;

function emptyResult(fen: string): AnalyzeResult {
  return { fen, bestMove: "", lines: [], depth: 0 };
}

/**
 * Drives a Stockfish web worker.
 *
 * The engine handles one search at a time, so requests go through an explicit
 * queue. Submitting while a search is running stops it, and pending requests
 * can be cancelled — both matter because the analysis board restarts its
 * evaluation on every board navigation.
 */
export function useStockfish(options: UseStockfishOptions = {}) {
  const {
    multipv: defaultMultipv = 1,
    hashMb = 64,
    skillLevel,
    elo = null,
    enabled = true,
  } = options;

  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const disposedRef = useRef(false);

  const currentRef = useRef<Task | null>(null);
  const queueRef = useRef<Task[]>([]);
  const linesRef = useRef<Map<number, EngineLine>>(new Map());
  const appliedMultipvRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [engine] = useState(() => (typeof window === "undefined" ? null : selectEngine()));
  // `engine` is null on the server but already resolved during the first browser
  // render, so `engineLabel` would differ between the two and React reports a
  // hydration mismatch. `false` during SSR and the hydration render, `true`
  // afterwards — so the neutral name is held until it is safe to reveal which
  // build actually loaded.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);

  const post = useCallback((command: string) => {
    workerRef.current?.postMessage(command);
  }, []);

  const sortedLines = useCallback(
    () => [...linesRef.current.values()].sort((a, b) => a.multipv - b.multipv),
    [],
  );

  // A deep search emits info lines faster than React should re-render.
  const flushLines = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (!disposedRef.current) setLines(sortedLines());
    }, LINE_UPDATE_INTERVAL_MS);
  }, [sortedLines]);

  const startTask = useCallback(
    (task: Task) => {
      linesRef.current = new Map();
      currentRef.current = task;
      setLines([]);
      setIsAnalyzing(true);

      if (appliedMultipvRef.current !== task.multipv) {
        appliedMultipvRef.current = task.multipv;
        post(setOption("MultiPV", task.multipv));
      }

      post(`position fen ${task.fen}`);
      post(task.go);
    },
    [post],
  );

  /** Start the next queued search if the engine is idle. */
  const pump = useCallback(() => {
    if (currentRef.current || disposedRef.current || !readyRef.current) return;
    const next = queueRef.current.shift();
    if (next) startTask(next);
  }, [startTask]);

  /**
   * Drop queued searches, settling their callers with an empty result.
   * Pass a kind to drop only that kind.
   */
  const cancelQueued = useCallback((kind?: Task["kind"]) => {
    const queued = queueRef.current;
    queueRef.current = kind ? queued.filter((task) => task.kind !== kind) : [];
    const dropped = kind ? queued.filter((task) => task.kind === kind) : queued;
    for (const task of dropped) task.settle(emptyResult(task.fen));
  }, []);

  const submit = useCallback(
    (task: Task) => {
      // A bounded search must never queue behind a pending `infinite` one.
      //
      // The queue is FIFO and `go infinite` only ends when something stops it.
      // The live-eval effect re-submits an infinite task on every position
      // change, so if one was still queued when `analyze` arrived, the pump
      // would start THAT next and the bounded search would wait behind a search
      // nobody was going to stop — awaiting forever. That is what left the coach
      // panel hanging.
      //
      // Dropping queued infinite tasks is safe: they are only the ambient eval,
      // they settle with an empty result that nothing reads, and the effect
      // re-establishes the live search as soon as the board settles.
      if (task.kind === "search") cancelQueued("infinite");

      queueRef.current.push(task);
      if (currentRef.current) {
        // Cut the running search short; its `bestmove` will pump the queue.
        post("stop");
      } else {
        pump();
      }
    },
    [cancelQueued, post, pump],
  );

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !engine) return;

    disposedRef.current = false;
    let worker: Worker;
    try {
      worker = new Worker(engine.url);
    } catch (error) {
      console.error("[stockfish] failed to start worker:", error);
      return;
    }
    workerRef.current = worker;

    worker.onerror = (event) => {
      console.error("[stockfish] worker error:", event.message);
    };

    worker.onmessage = (event: MessageEvent) => {
      const line = typeof event.data === "string" ? event.data : "";
      if (!line) return;

      if (line === "uciok") {
        if (engine.supportsThreads) {
          worker.postMessage(setOption("Threads", defaultThreads()));
        }
        worker.postMessage(setOption("Hash", hashMb));
        worker.postMessage("isready");
        return;
      }

      if (line === "readyok") {
        if (disposedRef.current) return;
        readyRef.current = true;
        setIsReady(true);
        pump();
        return;
      }

      const task = currentRef.current;
      if (!task) return;

      const info = parseInfoLine(line, task.fen);
      if (info) {
        // Keep the deepest snapshot per MultiPV slot so the eval bar does not
        // jitter on shallow re-searches.
        const existing = linesRef.current.get(info.multipv);
        if (!existing || info.depth >= existing.depth) {
          linesRef.current.set(info.multipv, info);
          flushLines();
        }
        return;
      }

      const best = parseBestMove(line);
      if (best) {
        const collected = sortedLines();
        currentRef.current = null;

        if (!disposedRef.current) {
          setLines(collected);
          setIsAnalyzing(false);
        }

        task.settle({
          fen: task.fen,
          bestMove: best.bestMove,
          lines: collected,
          depth: collected[0]?.depth ?? 0,
        });

        pump();
      }
    };

    worker.postMessage("uci");

    return () => {
      disposedRef.current = true;
      readyRef.current = false;
      setIsReady(false);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      // Settle everything still outstanding so no caller is left awaiting.
      const pending = currentRef.current;
      currentRef.current = null;
      pending?.settle(emptyResult(pending.fen));
      const queued = queueRef.current;
      queueRef.current = [];
      for (const queuedTask of queued) queuedTask.settle(emptyResult(queuedTask.fen));

      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled, engine, hashMb, flushLines, sortedLines, pump]);

  /** Applies strength options. Safe to call before the engine is ready. */
  const setStrength = useCallback(
    (strength: StrengthOptions) => {
      if (strength.skillLevel !== undefined) {
        post(setOption("Skill Level", Math.max(0, Math.min(20, strength.skillLevel))));
      }
      if (strength.elo === null) {
        post(setOption("UCI_LimitStrength", false));
      } else if (strength.elo !== undefined) {
        post(setOption("UCI_LimitStrength", true));
        post(setOption("UCI_Elo", Math.max(1320, Math.min(3190, strength.elo))));
      }
    },
    [post],
  );

  useEffect(() => {
    if (!isReady) return;
    setStrength({ skillLevel, elo });
  }, [isReady, skillLevel, elo, setStrength]);

  /**
   * Search a position, resolving when the engine reports `bestmove`.
   * Awaiting these in a loop (as the full-game scan does) runs them in order.
   */
  const analyze = useCallback(
    (request: AnalyzeRequest): Promise<AnalyzeResult> =>
      new Promise<AnalyzeResult>((resolve) => {
        if (disposedRef.current) {
          resolve(emptyResult(request.fen));
          return;
        }

        // A task settles only when its `bestmove` arrives. If the worker ever
        // misses one — a dropped message, a search superseded at the wrong
        // moment — the caller would await forever, and the UI that awaits it
        // (the coach panel) spins with no error and no way out. Bound it: a
        // late `bestmove` still settles first because `settled` guards both.
        let settled = false;
        const finish = (result: AnalyzeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          console.warn(`[stockfish] search timed out after ${SEARCH_TIMEOUT_MS}ms`);
          // Nudge the engine so a genuinely stuck search cannot block the queue.
          post("stop");
          finish(emptyResult(request.fen));
        }, SEARCH_TIMEOUT_MS);

        submit({
          fen: request.fen,
          go: request.movetimeMs
            ? `go movetime ${request.movetimeMs}`
            : `go depth ${request.depth ?? 16}`,
          multipv: request.multipv ?? defaultMultipv,
          kind: "search",
          settle: finish,
        });
      }),
    [submit, defaultMultipv, post],
  );

  /** Halt the current search and discard anything queued behind it. */
  const stop = useCallback(() => {
    cancelQueued();
    if (currentRef.current) post("stop");
  }, [cancelQueued, post]);

  /**
   * Tear down the live evaluation only.
   *
   * The analysis board's effect cleanup runs *after* a full-game scan has
   * already queued its first request, so an unconditional `stop()` there would
   * cancel the scan's own work. This leaves bounded searches alone.
   */
  const stopInfinite = useCallback(() => {
    cancelQueued("infinite");
    if (currentRef.current?.kind === "infinite") post("stop");
  }, [cancelQueued, post]);

  /**
   * Analyse a position indefinitely, streaming into `lines` until it is
   * stopped or a later request supersedes it. Drives the live evaluation.
   */
  const startInfinite = useCallback(
    (fen: string, multipv?: number) => {
      cancelQueued("infinite");
      submit({
        fen,
        go: "go infinite",
        multipv: multipv ?? defaultMultipv,
        kind: "infinite",
        settle: () => undefined,
      });
    },
    [cancelQueued, submit, defaultMultipv],
  );

  /** Clear the transposition table between unrelated positions. */
  const newGame = useCallback(() => {
    post("ucinewgame");
    post("isready");
  }, [post]);

  return {
    isReady,
    isAnalyzing,
    lines,
    analyze,
    startInfinite,
    stop,
    stopInfinite,
    setStrength,
    newGame,
    flavor: (engine?.flavor ?? "wasm-st") as EngineFlavor,
    engineLabel: hydrated ? (engine?.label ?? "Stockfish") : "Stockfish",
  };
}
