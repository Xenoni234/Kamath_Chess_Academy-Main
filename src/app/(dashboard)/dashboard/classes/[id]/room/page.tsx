"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSocket } from "@/lib/socket/client";

type ChatMessage = { id: string; userId: string; username: string; body: string; createdAt: string };
type RosterEntry = { userId: string; username: string };
type Room = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  meetingUrl: string | null;
  liveStartedAt: string | null;
  coachName: string | null;
};

export default function ClassRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [room, setRoom] = useState<Room | null>(null);
  const [isCoach, setIsCoach] = useState(false);
  const [viewerName, setViewerName] = useState("student");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/classes/${id}/room`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      setError(data.message ?? "Could not open this room.");
      return;
    }
    setRoom(data.room);
    setIsCoach(data.isCoach);
    setViewerName(data.viewerName ?? "student");
    setMessages(data.messages ?? []);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Socket: join the class room, receive chat + roster.
  useEffect(() => {
    if (!room) return;
    const socket = getSocket();
    socket.emit("class:join", { classId: id });

    const onMessage = (m: ChatMessage) => setMessages((prev) => [...prev, m]);
    const onRoster = (r: RosterEntry[]) => setRoster(r);
    const onError = (e: { message: string }) => setError(e.message);

    socket.on("class:message", onMessage);
    socket.on("class:roster", onRoster);
    socket.on("class:error", onError);

    return () => {
      socket.emit("class:leave", { classId: id });
      socket.off("class:message", onMessage);
      socket.off("class:roster", onRoster);
      socket.off("class:error", onError);
    };
  }, [room, id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    getSocket().emit("class:message", { classId: id, body });
    setDraft("");
  }

  async function toggleLive(action: "start" | "end") {
    setBusy(true);
    try {
      const res = await fetch(`/api/classes/${id}/room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.success) await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !room) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-kca-danger">{error}</p>
        <Link href="/dashboard/classes" className="btn-secondary mt-4 inline-block">
          ← Back to classes
        </Link>
      </div>
    );
  }
  if (!room) return <div className="mx-auto max-w-3xl px-4 py-10 text-kca-gray-400">Loading room…</div>;

  const jitsiSrc = `https://meet.jit.si/KCA-${room.id}#userInfo.displayName=%22${encodeURIComponent(
    viewerName,
  )}%22&config.prejoinPageEnabled=false`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/classes" className="text-sm text-kca-gray-400 hover:text-kca-cyan">
            ← Classes
          </Link>
          <h1 className="section-heading">{room.title}</h1>
          <p className="text-sm text-kca-gray-400">
            {room.coachName ? `Coach ${room.coachName} · ` : ""}
            <span className={room.status === "ONGOING" ? "text-kca-success" : "text-kca-gray-400"}>
              {room.status === "ONGOING" ? "● Live" : room.status.toLowerCase()}
            </span>
          </p>
        </div>
        {isCoach && (
          <div className="flex gap-2">
            {room.status !== "ONGOING" ? (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => toggleLive("start")}>
                Start class
              </button>
            ) : (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => toggleLive("end")}>
                End class
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        {/* Video */}
        <div className="card overflow-hidden p-0">
          {room.meetingUrl ? (
            <div className="flex min-h-[24rem] flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-kca-gray-100">This class uses an external meeting link.</p>
              <a href={room.meetingUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
                Open meeting ↗
              </a>
            </div>
          ) : (
            <div className="flex flex-col">
              <iframe
                title="Class video"
                src={jitsiSrc}
                className="h-[70vh] min-h-[24rem] w-full border-0"
                allow="camera; microphone; display-capture; fullscreen; speaker-selection; autoplay"
              />
              <a
                href={`https://meet.jit.si/KCA-${room.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="border-t border-kca-border px-3 py-2 text-center text-xs text-kca-gray-400 hover:text-kca-cyan"
              >
                Video not loading? Open it in a new tab ↗
              </a>
            </div>
          )}
        </div>

        {/* Chat + roster */}
        <div className="flex flex-col gap-4">
          <div className="card">
            <h2 className="mb-2 text-sm font-semibold text-kca-white">In room ({roster.length})</h2>
            <ul className="space-y-1 text-sm text-kca-gray-100">
              {roster.length === 0 ? (
                <li className="text-kca-gray-500">No one yet</li>
              ) : (
                roster.map((r) => (
                  <li key={r.userId} className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-kca-success" />
                    {r.username}
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="card flex min-h-[20rem] flex-col">
            <h2 className="mb-2 text-sm font-semibold text-kca-white">Class chat</h2>
            <div className="mb-2 flex-1 space-y-2 overflow-y-auto pr-1">
              {messages.length === 0 ? (
                <p className="text-sm text-kca-gray-500">No messages yet — say hello.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className="text-sm">
                    <span className="font-medium text-kca-cyan">{m.username}</span>{" "}
                    <span className="text-kca-gray-100">{m.body}</span>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2">
              <input
                className="input-field flex-1 py-2 text-sm"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Message the class…"
                maxLength={2000}
              />
              <button type="button" className="btn-primary px-4" onClick={send} disabled={!draft.trim()}>
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
