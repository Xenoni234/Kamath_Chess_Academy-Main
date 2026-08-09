"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { z } from "zod";
import type { explainMoveSchema } from "@/lib/validations/phase2";

// Derived from the Zod schema rather than imported from @/lib/claude, which
// would pull the Anthropic SDK into the browser bundle.
export type ExplainParams = z.infer<typeof explainMoveSchema>;

type ExplainPanelProps = {
  /**
   * Assembles the request. Returns null when there is nothing to explain —
   * e.g. at the root position, or before the engine has produced any lines.
   */
  buildParams: () => Promise<ExplainParams | null>;
  /** Changing this clears the previous explanation (used for the current ply). */
  resetKey: string | number;
  disabled?: boolean;
};

export default function ExplainPanel({ buildParams, resetKey, disabled }: ExplainPanelProps) {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abandon an in-flight explanation when the user navigates elsewhere.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setText("");
    setError(null);
    setIsStreaming(false);
  }, [resetKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleExplain = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setText("");
    setError(null);
    setIsStreaming(true);

    try {
      const params = await buildParams();
      if (!params) {
        setError("Play or select a move first, then ask for an explanation.");
        return;
      }
      if (controller.signal.aborted) return;

      const response = await fetch("/api/analysis/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (!response.ok) {
        const message =
          response.status === 429
            ? "You've asked for a lot of explanations — try again in a minute."
            : response.status === 401
              ? "Your session expired. Please log in again."
              : "Could not generate an explanation.";
        setError(message);
        return;
      }

      const body = response.body;
      if (!body) {
        setError("Could not generate an explanation.");
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();

      // Append tokens as they arrive so the coach's answer types itself out.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) setText((previous) => previous + chunk);
      }
    } catch (streamError) {
      if ((streamError as Error).name !== "AbortError") {
        setError("Could not generate an explanation.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <div className="card p-4 bg-kca-surface border border-kca-border">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-kca-cyan" />
          <span className="text-[11px] uppercase tracking-wider text-kca-gray-400">
            Coach explanation
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleExplain()}
          disabled={disabled || isStreaming}
          className="btn-secondary py-1.5 px-3 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStreaming ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Thinking
            </span>
          ) : (
            "Explain move"
          )}
        </button>
      </div>

      {error ? (
        <p className="text-sm text-kca-danger">{error}</p>
      ) : text ? (
        <p className="text-sm text-kca-gray-100 leading-relaxed whitespace-pre-wrap">
          {text}
          {isStreaming && <span className="inline-block w-1.5 h-4 ml-0.5 bg-kca-cyan align-middle animate-pulse" />}
        </p>
      ) : (
        <p className="text-sm text-kca-gray-400">
          Ask Claude why the engine prefers a different move here.
        </p>
      )}
    </div>
  );
}
