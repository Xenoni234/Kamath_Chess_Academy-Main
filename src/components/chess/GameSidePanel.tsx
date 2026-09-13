"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, NotebookPen, Send } from "lucide-react";
import { cn } from "@/lib/utils";

export type GameChatMessage = {
  id: string;
  userId: string;
  username: string;
  body: string;
  at: number;
};

type GameSidePanelProps = {
  gameId: string;
  userId: string;
  messages: GameChatMessage[];
  onSend: (body: string) => void;
  /** Spectators read the chat but cannot post — see the socket handler. */
  canChat: boolean;
};

/**
 * Notes and chat for the game room, which previously had a move list and a lot of empty
 * screen.
 *
 * **Notes are local to this browser, on purpose.** A student thinking "he always plays
 * this" during a rated game is writing to themselves; sending that to the server would
 * make it academy data about a minor, with retention and erasure obligations, to no
 * benefit. `localStorage` keyed by game id is the honest scope — and the panel says so, so
 * nobody expects their coach to read it.
 */
export default function GameSidePanel({
  gameId,
  userId,
  messages,
  onSend,
  canChat,
}: GameSidePanelProps) {
  const storageKey = `kca-game-notes-${gameId}`;
  const [tab, setTab] = useState<"notes" | "chat">("notes");
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Read in the initialiser rather than an effect, so the notes are there on the first
  // paint instead of flashing empty. localStorage throws in a private window and in some
  // embedded contexts, so every access is guarded and empty is always a valid outcome.
  const [notes, setNotes] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, notes);
      } catch {
        /* nothing we can do, and nothing worth telling a child about */
      }
    }, 400);
    return () => window.clearTimeout(id);
  }, [notes, storageKey]);

  // Scroll the chat's OWN container — never scrollIntoView, which walks every scrollable
  // ancestor and would drag the board off screen.
  useEffect(() => {
    if (tab !== "chat") return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, tab]);

  /**
   * Unread badge, derived rather than counted.
   *
   * Adjusting state during render is the pattern React documents for "some state depends
   * on a prop that changed" — the alternative here was a setState inside an effect plus a
   * ref read during render, which is two lint errors and a cascading re-render for a
   * number we can simply subtract.
   */
  const [seenCount, setSeenCount] = useState(messages.length);
  if (tab === "chat" && seenCount !== messages.length) setSeenCount(messages.length);
  const unread = Math.max(0, messages.length - seenCount);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
  };

  return (
    <div className="flex flex-1 min-h-[240px] flex-col overflow-hidden rounded-xl border border-kca-border bg-kca-surface shadow-sm">
      <div className="flex border-b border-kca-border bg-kca-surface-2">
        {(["notes", "chat"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-wide transition-colors",
              tab === key
                ? "border-b-2 border-kca-cyan text-kca-cyan"
                : "text-kca-gray-400 hover:text-kca-white",
            )}
          >
            {key === "notes" ? <NotebookPen className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
            {key}
            {key === "chat" && unread > 0 && (
              <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-kca-cyan px-1.5 text-[10px] font-bold text-kca-black">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "notes" ? (
        <div className="flex flex-1 flex-col p-3">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="What is your plan here? Write it down…"
            className="input-field flex-1 resize-none text-sm leading-relaxed"
          />
          <p className="mt-2 text-[11px] text-kca-gray-400">
            Saved on this device only — your coach cannot see these.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
            {messages.length === 0 ? (
              <p className="py-6 text-center text-xs text-kca-gray-400">
                No messages yet — say good luck!
              </p>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                    message.userId === userId
                      ? "ml-auto bg-kca-cyan/15 text-kca-white"
                      : "bg-kca-surface-2 text-kca-gray-100",
                  )}
                >
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-kca-gray-400">
                    {message.userId === userId ? "You" : message.username}
                  </div>
                  {message.body}
                </div>
              ))
            )}
          </div>

          {canChat ? (
            <div className="flex gap-2 border-t border-kca-border p-3">
              <input
                value={draft}
                maxLength={300}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="Say something…"
                className="input-field flex-1 text-sm"
              />
              <button
                type="button"
                onClick={send}
                disabled={!draft.trim()}
                aria-label="Send message"
                className="btn-primary px-3 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <p className="border-t border-kca-border p-3 text-center text-[11px] text-kca-gray-400">
              Only the two players can send messages.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
