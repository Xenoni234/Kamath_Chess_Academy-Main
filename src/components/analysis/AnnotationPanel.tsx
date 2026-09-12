"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

export type Annotation = {
  id: string;
  ply: number;
  body: string;
  coachId: string;
  coachName: string;
  updatedAt: string;
  mine: boolean;
};

/**
 * Coach notes on the current move.
 *
 * Unlike `ExplainPanel`, this component is deliberately **not** remounted on every
 * ply change. ExplainPanel is keyed to the position so a stale AI explanation
 * cannot linger — throwing its state away is the correct behaviour there. Doing
 * the same here would throw away a half-written note the moment the coach pressed
 * an arrow key to look at the next move.
 *
 * So the editor persists across ply changes and reseeds its text from whatever
 * note exists at the new ply — but only when the coach is not mid-edit on a
 * different one. `draftsRef` holds unsaved text per ply, so navigating away keeps
 * the draft and offers it back when you return.
 */
export default function AnnotationPanel({
  gameId,
  ply,
  moveLabel,
  onAnnotationsChange,
}: {
  gameId: string | null;
  ply: number;
  moveLabel?: string;
  onAnnotationsChange?: (byPly: Map<number, string>) => void;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [canAnnotate, setCanAnnotate] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  /** Unsaved drafts, keyed by ply, so navigating away does not lose them. */
  const draftsRef = useRef<Map<number, string>>(new Map());
  const notifyRef = useRef(onAnnotationsChange);
  useEffect(() => {
    notifyRef.current = onAnnotationsChange;
  }, [onAnnotationsChange]);

  const publish = useCallback((list: Annotation[]) => {
    const byPly = new Map<number, string>();
    for (const a of list) byPly.set(a.ply, a.body);
    notifyRef.current?.(byPly);
  }, []);

  const load = useCallback(async () => {
    if (!gameId) return;
    try {
      const res = await fetchWithAuth(`/api/games/${gameId}/annotations`);
      const data = await res.json();
      if (!res.ok || !data.success) return;
      setAnnotations(data.annotations ?? []);
      setCanAnnotate(Boolean(data.canAnnotate));
      publish(data.annotations ?? []);
    } catch {
      /* non-fatal — the board still works without notes */
    } finally {
      setLoaded(true);
    }
  }, [gameId, publish]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Reseed the editor when the ply changes: an unsaved draft for that ply wins,
  // then a saved note, then empty.
  useEffect(() => {
    const saved = annotations.find((a) => a.ply === ply && a.mine)?.body ?? "";
    const pending = draftsRef.current.get(ply);
    setDraft(pending ?? saved);
    setStatus(null);
  }, [ply, annotations]);

  function edit(value: string) {
    setDraft(value);
    const saved = annotations.find((a) => a.ply === ply && a.mine)?.body ?? "";
    if (value === saved) draftsRef.current.delete(ply);
    else draftsRef.current.set(ply, value);
  }

  async function save() {
    if (!gameId) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetchWithAuth(`/api/games/${gameId}/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ply, body: draft }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setStatus(data.message ?? "Could not save that note.");
        return;
      }
      draftsRef.current.delete(ply);
      setStatus(draft.trim() ? "Saved" : "Removed");
      await load();
    } catch {
      setStatus("Could not save that note.");
    } finally {
      setSaving(false);
    }
  }

  if (!gameId || !loaded) return null;

  const others = annotations.filter((a) => a.ply === ply && !a.mine);
  const savedMine = annotations.find((a) => a.ply === ply && a.mine);
  // Derived from state, not from the drafts ref: reading a ref during render is
  // a React violation, and this comparison is exactly equivalent.
  const unsaved = draft !== (savedMine?.body ?? "");
  const total = annotations.length;

  // A student with no notes on the game sees nothing at all, rather than an empty
  // card explaining a feature that is not theirs.
  if (!canAnnotate && total === 0) return null;

  return (
    <div className="card">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-kca-white">
          Coach notes{moveLabel ? <span className="ml-1 font-mono text-kca-cyan">{moveLabel}</span> : null}
        </h3>
        <span className="text-xs text-kca-gray-500">
          {total} on this game
        </span>
      </div>

      {others.map((a) => (
        <div key={a.id} className="mb-2 rounded bg-kca-surface-2 p-2">
          <div className="mb-1 text-xs text-kca-gray-400">{a.coachName}</div>
          <p className="whitespace-pre-wrap text-sm text-kca-gray-100">{a.body}</p>
        </div>
      ))}

      {canAnnotate ? (
        <>
          <textarea
            className="input-field min-h-[5rem] w-full text-sm"
            placeholder={ply === 0 ? "A note on the game as a whole…" : "What should the student understand here?"}
            value={draft}
            maxLength={2000}
            onChange={(e) => edit(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-kca-gray-500">
              {status ?? (unsaved ? "Unsaved" : savedMine ? "Saved" : "")}
            </span>
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              disabled={saving || !unsaved}
              onClick={save}
            >
              {saving ? "Saving…" : savedMine && !draft.trim() ? "Remove note" : "Save note"}
            </button>
          </div>
        </>
      ) : (
        savedMine == null &&
        others.length === 0 && <p className="text-sm text-kca-gray-500">No note on this move.</p>
      )}
    </div>
  );
}
