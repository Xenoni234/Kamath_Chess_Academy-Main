"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSocket } from "@/lib/socket/client";
import { useMediaRoom, type RemoteStream } from "@/lib/media/roomClient";

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
  const [sfuEnabled, setSfuEnabled] = useState(false);
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
    setSfuEnabled(Boolean(data.sfuEnabled));
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
        {/* Video: external link → SFU (mediasoup) → embedded Jitsi fallback. */}
        <div className="card overflow-hidden p-0">
          {room.meetingUrl ? (
            <div className="flex min-h-[24rem] flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-kca-gray-100">This class uses an external meeting link.</p>
              <a href={room.meetingUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
                Open meeting ↗
              </a>
            </div>
          ) : sfuEnabled ? (
            <SfuStage classId={room.id} />
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

/** A <video> that binds a MediaStream via ref (srcObject isn't a real attribute). */
function MediaVideo({ stream, muted, className }: { stream: MediaStream; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

function MediaAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/** The mediasoup SFU stage: local self-view, remote camera grid, screen share,
 *  and mic/cam/share controls. Rendered only when the SFU is enabled. */
function SfuStage({ classId }: { classId: string }) {
  const { status, localStream, screenStream, remotes, micOn, camOn, toggleMic, toggleCam, shareScreen, stopScreen } =
    useMediaRoom(classId, true);

  const cameras = remotes.filter((r: RemoteStream) => r.kind === "video" && !r.screen);
  const screens = remotes.filter((r: RemoteStream) => r.screen);
  const audios = remotes.filter((r: RemoteStream) => r.kind === "audio");

  return (
    <div className="flex min-h-[24rem] flex-col">
      {status === "connecting" && (
        <div className="p-4 text-sm text-kca-gray-400">Connecting… please allow camera &amp; microphone.</div>
      )}
      {status === "error" && (
        <div className="p-4 text-sm text-kca-danger">
          Couldn&rsquo;t start video — check camera/mic permissions. You can still use the chat.
        </div>
      )}

      {(screens.length > 0 || screenStream) && (
        <div className="bg-black">
          {screenStream && <MediaVideo stream={screenStream} muted className="max-h-[50vh] w-full object-contain" />}
          {screens.map((s) => (
            <MediaVideo key={s.producerId} stream={s.stream} className="max-h-[50vh] w-full object-contain" />
          ))}
        </div>
      )}

      <div className="grid flex-1 grid-cols-2 gap-1 p-1 sm:grid-cols-3">
        {localStream && (
          <div className="relative">
            <MediaVideo stream={localStream} muted className="aspect-video w-full rounded bg-black object-cover" />
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-xs text-white">
              You{!camOn ? " · cam off" : ""}
            </span>
          </div>
        )}
        {cameras.map((r) => (
          <div key={r.producerId} className="relative">
            <MediaVideo stream={r.stream} className="aspect-video w-full rounded bg-black object-cover" />
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-xs text-white">{r.username}</span>
          </div>
        ))}
      </div>

      {audios.map((r) => (
        <MediaAudio key={r.producerId} stream={r.stream} />
      ))}

      <div className="flex items-center justify-center gap-2 border-t border-kca-border p-2">
        <button
          type="button"
          onClick={toggleMic}
          className={`rounded px-3 py-1.5 text-sm ${micOn ? "bg-kca-surface-3 text-kca-white" : "bg-kca-danger text-white"}`}
        >
          {micOn ? "Mute" : "Unmute"}
        </button>
        <button
          type="button"
          onClick={toggleCam}
          className={`rounded px-3 py-1.5 text-sm ${camOn ? "bg-kca-surface-3 text-kca-white" : "bg-kca-danger text-white"}`}
        >
          {camOn ? "Camera off" : "Camera on"}
        </button>
        {screenStream ? (
          <button type="button" onClick={stopScreen} className="rounded bg-kca-danger px-3 py-1.5 text-sm text-white">
            Stop sharing
          </button>
        ) : (
          <button type="button" onClick={shareScreen} className="rounded bg-kca-cyan px-3 py-1.5 text-sm text-black">
            Share screen
          </button>
        )}
      </div>
    </div>
  );
}
