"use client";
import { useEffect, useRef, useCallback, useState } from "react";

export type StockfishResult = {
  bestMove: string;
  evaluation: number;    // centipawns, positive = white better
  depth: number;
  mate?: number;
};

export function useStockfish() {
  const workerRef = useRef<Worker | null>(null);
  const resolverRef = useRef<((r: StockfishResult) => void) | null>(null);
  const resultRef = useRef<Partial<StockfishResult>>({});
  const readyRef = useRef(false);
  const fenRef = useRef<string>("");
  
  const [isReady, setIsReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentEval, setCurrentEval] = useState<Partial<StockfishResult>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    
    const worker = new Worker("/stockfish.js");
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const line = typeof e.data === "string" ? e.data : "";
      
      if (line === "uciok") {
        readyRef.current = true;
        setIsReady(true);
      }

      // Parse evaluation
      if (line.startsWith("info depth") && !line.includes("currmove")) {
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) {
          resultRef.current.depth = parseInt(depthMatch[1], 10);
        }

        const isBlackToMove = fenRef.current.includes(" b ");
        const multiplier = isBlackToMove ? -1 : 1;

        const cpMatch = line.match(/score cp (-?\d+)/);
        if (cpMatch) {
          resultRef.current.evaluation = parseInt(cpMatch[1], 10) * multiplier;
          delete resultRef.current.mate;
        }

        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) {
          resultRef.current.mate = parseInt(mateMatch[1], 10) * multiplier;
          delete resultRef.current.evaluation;
        }
        
        setCurrentEval({ ...resultRef.current });
      }

      // Parse bestmove
      if (line.startsWith("bestmove")) {
        const moveMatch = line.match(/bestmove\s+(\S+)/);
        if (moveMatch) {
          resultRef.current.bestMove = moveMatch[1];
          if (resolverRef.current) {
            resolverRef.current(resultRef.current as StockfishResult);
            resolverRef.current = null;
          }
          setIsAnalyzing(false);
        }
      }
    };

    worker.postMessage("uci");

    return () => {
      worker.terminate();
    };
  }, []);

  const findBestMove = useCallback((fen: string, depth: number = 15): Promise<StockfishResult> => {
    return new Promise((resolve) => {
      if (!workerRef.current || !readyRef.current) {
        resolve({ bestMove: "", evaluation: 0, depth: 0 });
        return;
      }
      
      setIsAnalyzing(true);
      resultRef.current = {};
      setCurrentEval({});
      resolverRef.current = resolve;
      fenRef.current = fen;
      
      workerRef.current.postMessage(`position fen ${fen}`);
      workerRef.current.postMessage(`go depth ${depth}`);
    });
  }, []);
  
  const startInfiniteAnalysis = useCallback((fen: string) => {
    if (!workerRef.current || !readyRef.current) return;
    
    setIsAnalyzing(true);
    resultRef.current = {};
    setCurrentEval({});
    fenRef.current = fen;
    
    workerRef.current.postMessage(`position fen ${fen}`);
    workerRef.current.postMessage(`go infinite`);
  }, []);
  
  const stopAnalysis = useCallback(() => {
    if (workerRef.current && isAnalyzing) {
      workerRef.current.postMessage("stop");
      setIsAnalyzing(false);
    }
  }, [isAnalyzing]);

  return { findBestMove, startInfiniteAnalysis, stopAnalysis, currentEval, isReady, isAnalyzing };
}
