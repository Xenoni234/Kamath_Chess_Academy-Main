"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSocket } from "@/lib/socket/client";
import { useMediaRoom, type RemoteStream } from "@/lib/media/roomClient";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";
import { useCallAnchor, useClassCall } from "@/components/media/ClassCallHost";

/** What the room route mints for this viewer. Null means JaaS is not configured. */
type JaasInfo = { appId: string | null; room: string; token: string | null } | null;

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
  videoRoomKey: string | null;
  coachName: string | null;
};

export default function ClassRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [room, setRoom] = useState<Room | null>(null);
  // Broader than isCoach: HR and HEAD run the academy and may need to start a
  // class, add a student or mark attendance when a coach is unavailable.
  const [canManage, setCanManage] = useState(false);
  const [sfuEnabled, setSfuEnabled] = useState(false);
  const [viewerName, setViewerName] = useState("student");
  // Minted server-side per viewer per room; null when JaaS is not configured, in which
  // case the embed falls back to public meet.jit.si.
  const [jaas, setJaas] = useState<JaasInfo>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetchWithAuth(`/api/classes/${id}/room`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      setError(data.message ?? "Could not open this room.");
      return;
    }
    setRoom(data.room);
    setCanManage(Boolean(data.canManage));
    setSfuEnabled(Boolean(data.sfuEnabled));
    setViewerName(data.viewerName ?? "student");
    setJaas(data.jaas ?? null);
    setMessages(data.messages ?? []);
  }, [id]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    // The coach ended it. Reload so the video tears down and the page shows the
    // class as finished, rather than leaving everyone in a call for a lesson that
    // is over.
    const onEnded = () => void load();

    socket.on("class:message", onMessage);
    socket.on("class:roster", onRoster);
    socket.on("class:error", onError);
    socket.on("class:ended", onEnded);

    return () => {
      socket.emit("class:leave", { classId: id });
      socket.off("class:message", onMessage);
      socket.off("class:roster", onRoster);
      socket.off("class:error", onError);
      socket.off("class:ended", onEnded);
    };
  }, [room, id, load]);

  // Scroll the chat list itself — never the page.
  //
  // This was `chatEndRef.current?.scrollIntoView({ behavior: "smooth" })`. scrollIntoView
  // scrolls EVERY scrollable ancestor, and the dashboard shell makes <main> one
  // (`md:h-screen md:overflow-y-auto`), so each incoming message smoothly scrolled the
  // whole class page — video, roster and all — down toward the chat box. Setting
  // scrollTop on the list cannot reach past the list.
  useEffect(() => {
    const list = chatScrollRef.current;
    if (list) list.scrollTop = list.scrollHeight;
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
      const res = await fetchWithAuth(`/api/classes/${id}/room`, {
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
        {canManage && (
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
          ) : room.status === "COMPLETED" ? (
            <div className="flex min-h-[24rem] flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-kca-gray-100">This class has ended.</p>
              <p className="text-sm text-kca-gray-400">The chat below stays available.</p>
            </div>
          ) : sfuEnabled ? (
            <SfuStage classId={room.id} />
          ) : (
            <CallSlot
              classId={room.id}
              classTitle={room.title}
              roomKey={room.videoRoomKey}
              displayName={viewerName}
              jaas={jaas}
            />
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

          {canManage && <AttendancePanel classId={id} presentUserIds={roster.map((r) => r.userId)} />}

          <div className="card flex min-h-[20rem] flex-col">
            <h2 className="mb-2 text-sm font-semibold text-kca-white">Class chat</h2>
            <div ref={chatScrollRef} className="mb-2 flex-1 space-y-2 overflow-y-auto pr-1">
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

type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
type AttendanceRow = {
  id: string;
  username: string;
  status: AttendanceStatus | null;
  note: string | null;
  markedAt: string | null;
};

const STATUSES: { value: AttendanceStatus; label: string; tone: string }[] = [
  { value: "PRESENT", label: "P", tone: "bg-kca-success text-black" },
  { value: "ABSENT", label: "A", tone: "bg-kca-danger text-white" },
  { value: "LATE", label: "L", tone: "bg-kca-warning text-black" },
  { value: "EXCUSED", label: "E", tone: "bg-kca-surface-3 text-kca-white" },
];

/**
 * Coach-only attendance marking.
 *
 * The roster comes from `GET /api/attendance`, which is enrollment-derived, and
 * NOT from the `class:roster` socket event that feeds the "In room" card above.
 * That event is connected-only presence: a student who never joined has no
 * socket and never appears in it, so sourcing the roster there would make the
 * absent students — the entire reason attendance exists — impossible to mark.
 *
 * Presence is still used, but only as a hint: on first load a student who is
 * currently connected and has no existing mark is pre-selected PRESENT. That
 * seeding happens once (`seededRef`). If it re-ran whenever presence changed, a
 * coach who deliberately marked someone ABSENT would see it flip back the moment
 * that student reconnected.
 */
function AttendancePanel({ classId, presentUserIds }: { classId: string; presentUserIds: string[] }) {
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const seededRef = useRef(false);
  // Adding a student from inside the room. The alternative is leaving a live
  // class for the Scheduling page, which is not something a coach mid-lesson will
  // do — so a student who turns up unenrolled simply never gets marked.
  const [adding, setAdding] = useState(false);
  const [addable, setAddable] = useState<{ id: string; username: string }[]>([]);
  const [pick, setPick] = useState("");
  // The dropdown only offers students this person already sees — for a coach that
  // is their own roster, which never contains the walk-in they are trying to add.
  // Typing an exact username covers that without letting anyone browse the
  // academy's student list.
  const [typed, setTyped] = useState("");
  // Presence is read through a ref so it can seed the first load without making
  // `load` re-run every time someone joins or leaves. Declared before the loading
  // effect below so it is populated first on mount — effects run in source order.
  const presentRef = useRef(presentUserIds);
  useEffect(() => {
    presentRef.current = presentUserIds;
  }, [presentUserIds]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/attendance?classId=${encodeURIComponent(classId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load the roster.");
        return;
      }
      const students: AttendanceRow[] = data.students ?? [];
      setRows(students);
      setMarks((prev) => {
        const next = { ...prev };
        for (const s of students) {
          // An existing mark always wins over presence and over local state.
          if (s.status) next[s.id] = s.status;
          else if (!seededRef.current && presentRef.current.includes(s.id)) next[s.id] = "PRESENT";
        }
        return next;
      });
      seededRef.current = true;
    } catch {
      setError("Could not load the roster.");
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    // Async: state is set after an await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loadAddable = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/students");
      const data = await res.json();
      if (!res.ok || !data.success) return;
      // /api/students is already scoped to what this caller may see — a coach's
      // roster, or everyone for staff. Filter out whoever is already on the
      // attendance list so the dropdown only offers real additions.
      const already = new Set(rows.map((r) => r.id));
      setAddable((data.students ?? []).filter((s: { id: string }) => !already.has(s.id)));
    } catch {
      /* non-fatal — the button just offers nothing */
    }
  }, [rows]);

  async function addStudent() {
    const byName = typed.trim();
    if (!pick && !byName) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/classes/${encodeURIComponent(classId)}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An explicit pick wins; otherwise the typed name is resolved server-side.
        body: JSON.stringify(pick ? { studentUserId: pick } : { username: byName }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not add that student.");
        return;
      }
      setAdding(false);
      setPick("");
      setTyped("");
      // Refetch rather than patch local state: the roster is the server's answer
      // and a batch-enrolled student may already have been there.
      await load();
    } catch {
      setError("Could not add that student.");
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const entries = Object.entries(marks).map(([userId, status]) => ({ userId, status }));
    if (entries.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, entries }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not save attendance.");
        return;
      }
      setSavedAt(new Date().toLocaleTimeString("en-IN"));
      await load();
    } catch {
      setError("Could not save attendance.");
    } finally {
      setSaving(false);
    }
  }

  const markedCount = Object.keys(marks).length;

  return (
    <div className="card">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-kca-white">Attendance</h2>
        <span className="text-xs text-kca-gray-400">
          {loading ? "loading…" : `${markedCount}/${rows.length} marked`}
        </span>
      </div>

      {error && <p className="mb-2 text-xs text-kca-danger">{error}</p>}

      {!loading && rows.length === 0 ? (
        <p className="text-sm text-kca-gray-500">No students are enrolled in this class yet.</p>
      ) : (
        <ul className="mb-3 max-h-64 space-y-2 overflow-y-auto pr-1">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-kca-gray-100" title={r.username}>
                {r.username}
                {presentUserIds.includes(r.id) && (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-kca-success align-middle" />
                )}
              </span>
              <span className="flex shrink-0 gap-1">
                {STATUSES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    title={s.value}
                    onClick={() => setMarks((m) => ({ ...m, [r.id]: s.value }))}
                    className={`h-6 w-6 rounded text-xs font-semibold transition ${
                      marks[r.id] === s.value ? s.tone : "bg-kca-surface-2 text-kca-gray-400 hover:text-kca-white"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mb-3 border-t border-kca-border pt-3">
        {adding ? (
          <div className="space-y-2">
            <select
              className="input-field w-full py-1.5 text-sm"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose a student…</option>
              {addable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.username}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary flex-1 py-1.5 text-xs"
                disabled={(!pick && !typed.trim()) || saving}
                onClick={addStudent}
              >
                Add to this class
              </button>
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => {
                  setAdding(false);
                  setPick("");
                  setTyped("");
                }}
              >
                Cancel
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-px flex-1 bg-kca-border" />
              <span className="text-[10px] uppercase tracking-wider text-kca-gray-500">or by username</span>
              <span className="h-px flex-1 bg-kca-border" />
            </div>
            <input
              className="input-field w-full py-1.5 text-sm"
              placeholder="Exact username"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addStudent()}
            />
            {addable.length === 0 && (
              <p className="text-xs text-kca-gray-500">
                Nobody on your roster is missing from this class — type a username to add anyone else.
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-kca-cyan hover:underline"
            onClick={() => {
              setAdding(true);
              void loadAddable();
            }}
          >
            + Add a student to this class
          </button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-kca-gray-500">{savedAt ? `Saved ${savedAt}` : "P / A / L / E"}</span>
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            disabled={saving || markedCount === 0}
            onClick={save}
          >
            {saving ? "Saving…" : "Save attendance"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The class room's video area.
 *
 * It renders no iframe of its own. It asks the persistent host (mounted in the dashboard
 * layout) to start or ADOPT the call, then publishes its own rectangle so the host's fixed
 * element lines up with this box and reads as embedded.
 *
 * Leaving the page unmounts only this placeholder. The call keeps running and becomes the
 * corner window, which is what lets a coach open the analysis board mid-lesson without
 * ending the class for everyone in it.
 *
 * Two properties of the old embed are preserved and must stay:
 *
 * **The room name is a secret from the server, not the class id.** It used to be
 * `KCA-<class cuid>`, so anyone who learned or guessed a class id could walk into a live
 * class of minors with no KCA account. The server mints a random key behind the
 * authorisation check and rotates it when the coach starts the class.
 *
 * **The display name goes through the IFrame API, never the URL.** It was in the
 * `#userInfo.displayName=` fragment, which puts a child's name into browser history and
 * the DOM `src` attribute.
 *
 * With JaaS configured the room is genuinely authenticated rather than merely obscure,
 * and nobody is asked to sign in to Jitsi — see `src/lib/media/jaas.ts`.
 */
function CallSlot({
  classId,
  classTitle,
  roomKey,
  displayName,
  jaas,
}: {
  classId: string;
  classTitle: string;
  roomKey: string | null;
  displayName: string;
  jaas: JaasInfo;
}) {
  const { startCall } = useClassCall();
  const ref = useCallAnchor(Boolean(roomKey));

  useEffect(() => {
    if (!roomKey) return;
    startCall({ classId, classTitle, roomKey, displayName, jaas });
  }, [classId, classTitle, roomKey, displayName, jaas, startCall]);

  if (!roomKey) {
    return (
      <div className="flex min-h-[24rem] items-center justify-center p-8 text-center text-sm text-kca-gray-400">
        Preparing the room…
      </div>
    );
  }

  // Just a measured box. The video is drawn over it by the host.
  return <div ref={ref} className="min-h-[24rem] w-full" />;
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
