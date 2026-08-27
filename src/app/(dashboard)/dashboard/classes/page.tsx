"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Video, Loader2 } from "lucide-react";

type ClassItem = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  meetingUrl: string | null;
  batchName: string | null;
  coachName: string | null;
};

function formatWhen(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const date = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = `${s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return `${date}, ${time}`;
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/classes")
      .then((r) => r.json())
      .then((d) => {
        if (active && d.success) setClasses(d.classes);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Upcoming Classes</h1>
        <p className="text-sm text-kca-gray-400">Your scheduled coaching sessions.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-kca-gray-400">
          <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
        </div>
      ) : classes.length === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">
          <CalendarDays className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p>No upcoming classes.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {classes.map((c) => (
            <div key={c.id} className="card p-5 border border-kca-border bg-kca-surface flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-kca-white">{c.title}</div>
                <div className="text-sm text-kca-gray-400 mt-1">
                  {formatWhen(c.startsAt, c.endsAt)}
                  {c.batchName && <span> · {c.batchName}</span>}
                  {c.coachName && <span> · Coach {c.coachName}</span>}
                </div>
                {c.description && <div className="text-sm text-kca-gray-100 mt-2">{c.description}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {c.meetingUrl && (
                  <a href={c.meetingUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary py-2 px-4 text-sm">
                    <Video className="w-4 h-4" /> Meeting ↗
                  </a>
                )}
                {/* Plain <a> (full navigation) so the room document loads without
                    COEP isolation and can embed the video iframe. */}
                <a href={`/dashboard/classes/${c.id}/room`} className="btn-primary py-2 px-4 text-sm">
                  Enter room
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
