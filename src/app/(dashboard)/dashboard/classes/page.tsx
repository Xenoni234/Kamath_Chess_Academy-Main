"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays, Video, Loader2, CalendarPlus, Ban, Trash2 } from "lucide-react";
import { useSession } from "@/components/auth/RoleContext";

type ClassItem = {
  id: string;
  title: string;
  description: string | null;
  status: "SCHEDULED" | "ONGOING" | "COMPLETED" | "CANCELLED";
  startsAt: string;
  endsAt: string;
  meetingUrl: string | null;
  batchName: string | null;
  coachName: string | null;
  /** Whether THIS viewer may move or cancel it — the server decides, not the page. */
  canManage: boolean;
};

function formatWhen(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const date = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = `${s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return `${date}, ${time}`;
}

type Buckets = { ongoing: ClassItem[]; upcoming: ClassItem[]; ended: ClassItem[] };

export default function ClassesPage() {
  const { role } = useSession();
  const [buckets, setBuckets] = useState<Buckets>({ ongoing: [], upcoming: [], ended: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // A coach and the head both teach, so both get the link to go and arrange one.
  // This is the page they land on looking for it; sending them hunting through
  // the sidebar for "Schedule" was the whole problem.
  const canSchedule = role === "COACH" || role === "HR" || role === "HEAD";
  const isHead = role === "HEAD";

  async function load() {
    const d = await fetch("/api/classes").then((r) => r.json());
    if (d.success) setBuckets({ ongoing: d.ongoing ?? [], upcoming: d.upcoming ?? [], ended: d.ended ?? [] });
  }

  useEffect(() => {
    let active = true;
    fetch("/api/classes")
      .then((r) => r.json())
      .then((d) => {
        if (!active || !d.success) return;
        setBuckets({ ongoing: d.ongoing ?? [], upcoming: d.upcoming ?? [], ended: d.ended ?? [] });
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  async function cancelClass(item: ClassItem) {
    if (!confirm(`Cancel "${item.title}"? Everyone enrolled will be told it is off.`)) return;
    setBusy(item.id);
    try {
      await fetch(`/api/classes/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteClass(item: ClassItem) {
    if (!confirm(`Delete "${item.title}" permanently? Cancelling is usually the right choice.`)) return;
    setBusy(item.id);
    try {
      await fetch(`/api/classes/${item.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const total = buckets.ongoing.length + buckets.upcoming.length + buckets.ended.length;

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Classes</h1>
          <p className="text-sm text-kca-gray-400">Your coaching sessions — live now, coming up, and finished.</p>
        </div>
        {canSchedule && (
          <Link href="/dashboard/schedule" className="btn-primary shrink-0 px-4 py-2 text-sm">
            <CalendarPlus className="h-4 w-4" /> Schedule a class
          </Link>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-kca-gray-400">
          <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
        </div>
      ) : total === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">
          <CalendarDays className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p>No classes yet.</p>
          {canSchedule && (
            <Link href="/dashboard/schedule" className="btn-primary mt-4 inline-flex px-4 py-2 text-sm">
              <CalendarPlus className="h-4 w-4" /> Schedule your first class
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {/* Live first: if something is happening now, that is the only thing
              anyone opening this page cares about. */}
          <Section
            title="Live now"
            tone="text-kca-success"
            items={buckets.ongoing}
            empty={null}
            live
            busy={busy}
            onCancel={cancelClass}
            onDelete={isHead ? deleteClass : undefined}
          />
          <Section
            title="Upcoming"
            tone="text-kca-white"
            items={buckets.upcoming}
            empty="Nothing scheduled."
            busy={busy}
            onCancel={cancelClass}
            onDelete={isHead ? deleteClass : undefined}
          />
          <Section
            title="Ended"
            tone="text-kca-gray-400"
            items={buckets.ended}
            empty="No finished classes yet."
            past
            busy={busy}
            onDelete={isHead ? deleteClass : undefined}
          />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  tone,
  items,
  empty,
  live = false,
  past = false,
  busy,
  onCancel,
  onDelete,
}: {
  title: string;
  tone: string;
  items: ClassItem[];
  empty: string | null;
  live?: boolean;
  past?: boolean;
  busy: string | null;
  onCancel?: (item: ClassItem) => void;
  onDelete?: (item: ClassItem) => void;
}) {
  // A "Live now" heading above nothing is noise; the other two always show so
  // their emptiness is itself information.
  if (items.length === 0 && empty === null) return null;

  return (
    <section>
      <h2 className={`mb-3 flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wider ${tone}`}>
        {live && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-kca-success" />}
        {title}
        <span className="text-xs font-normal text-kca-gray-500">({items.length})</span>
      </h2>

      {items.length === 0 ? (
        <div className="card border border-kca-border bg-kca-surface p-5 text-sm text-kca-gray-500">{empty}</div>
      ) : (
        <div className="space-y-3">
          {items.map((c) => (
            <div
              key={c.id}
              className={`card flex flex-col gap-4 border bg-kca-surface p-5 md:flex-row md:items-center md:justify-between ${
                live ? "border-kca-success/40" : "border-kca-border"
              } ${past ? "opacity-70" : ""}`}
            >
              <div>
                <div className="text-lg font-semibold text-kca-white">{c.title}</div>
                <div className="mt-1 text-sm text-kca-gray-400">
                  {formatWhen(c.startsAt, c.endsAt)}
                  {c.batchName && <span> · {c.batchName}</span>}
                  {c.coachName && <span> · Coach {c.coachName}</span>}
                  {/* A cancelled class and a taught one both sit under "Ended"
                      and otherwise look identical — say which it was. */}
                  {c.status === "CANCELLED" && <span className="ml-2 text-kca-warning">Cancelled</span>}
                </div>
                {c.description && <div className="mt-2 text-sm text-kca-gray-100">{c.description}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {c.meetingUrl && !past && (
                  <a href={c.meetingUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary px-4 py-2 text-sm">
                    <Video className="h-4 w-4" /> Meeting ↗
                  </a>
                )}
                {/* Plain <a> (full navigation) so the room document loads without
                    COEP isolation and can embed the video iframe. */}
                <a
                  href={`/dashboard/classes/${c.id}/room`}
                  className={`${past ? "btn-secondary" : "btn-primary"} px-4 py-2 text-sm`}
                >
                  {past ? "View" : "Enter room"}
                </a>
                {/* Offered only where the server would honour it: the class's own
                    coach, or the head, who may act on anyone's class. */}
                {c.canManage && onCancel && c.status !== "CANCELLED" && (
                  <button
                    onClick={() => onCancel(c)}
                    disabled={busy === c.id}
                    title="Cancel this class"
                    className="rounded-lg border border-kca-border px-3 py-2 text-sm text-kca-gray-400 hover:border-kca-warning hover:text-kca-warning disabled:opacity-50"
                  >
                    {busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                  </button>
                )}
                {c.canManage && onDelete && (
                  <button
                    onClick={() => onDelete(c)}
                    disabled={busy === c.id}
                    title="Delete permanently (head only)"
                    className="rounded-lg border border-kca-border px-3 py-2 text-sm text-kca-gray-400 hover:border-kca-danger hover:text-kca-danger disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
