"use client";

import { useCallback, useEffect, useState } from "react";

type Parent = { username: string; email: string; linkedAt: string };

/**
 * The student's parent code, and who is already using it.
 *
 * Shown to the student rather than handed out by staff, because the student is
 * the one who knows which adult should get it. Registering as a parent needs this
 * code *and* the student's username — the code alone does not say whose it is,
 * and the username alone is guessable.
 *
 * The list of linked parents matters as much as the code: it is how a student
 * notices an account they did not expect, and the regenerate button is what they
 * do about it.
 */
export default function ParentCodeCard() {
  const [code, setCode] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [parents, setParents] = useState<Parent[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/user/parent-code");
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? null);
        return;
      }
      setCode(data.code);
      setUsername(data.username ?? "");
      setParents(data.parents ?? []);
    } catch {
      setError("Could not load your parent code.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function regenerate() {
    if (!window.confirm("Create a new code? The old one stops working immediately.")) return;
    setBusy(true);
    setCopied(false);
    try {
      const res = await fetch("/api/user/parent-code", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not create a new code.");
        return;
      }
      setCode(data.code);
      setRevealed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || (!code && !error)) return null;

  return (
    <div className="card mt-6">
      <h2 className="mb-1 text-sm font-semibold text-kca-white">Parent access</h2>
      <p className="mb-3 text-xs text-kca-gray-400">
        For a parent to follow your progress, they register with <strong>your username</strong> and the code below.
      </p>

      {error && <p className="mb-2 text-sm text-kca-danger">{error}</p>}

      {code && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-kca-surface-2 p-3">
            <div className="min-w-0">
              <div className="text-xs text-kca-gray-400">Your username</div>
              <div className="font-mono text-sm text-kca-white">{username}</div>
            </div>
            <div className="min-w-0">
              <div className="text-xs text-kca-gray-400">Parent code</div>
              <div className="font-mono text-lg font-bold tracking-wider text-kca-cyan">
                {revealed ? code : "•••-•••"}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => setRevealed((r) => !r)}
              >
                {revealed ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => {
                  navigator.clipboard?.writeText(code).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                  setRevealed(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-kca-gray-500">
              {parents.length === 0
                ? "No parent is linked yet."
                : `Linked: ${parents.map((p) => p.username).join(", ")}`}
            </span>
            <button
              type="button"
              className="text-xs text-kca-danger hover:underline disabled:opacity-40"
              disabled={busy}
              onClick={regenerate}
            >
              {busy ? "Working…" : "Create a new code"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
