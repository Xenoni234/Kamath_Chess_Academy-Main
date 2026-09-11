"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Users, CalendarPlus, X } from "lucide-react";

type Batch = {
  id: string;
  name: string;
  description: string | null;
  coach: { userId: string; username: string } | null;
  classCount: number;
  studentCount: number;
};
type UserLite = { id: string; username: string; role: string };

const selectClass = "input-field py-2 text-sm";

/**
 * One console, two audiences.
 *
 * A coach has full command of their own teaching here: form a batch, add students
 * to it, and schedule sessions whenever suits them. What they do not get is the
 * academy-wide half — assigning a batch to a different coach, and the staff-only
 * roster dropdowns. So a coach adds a student by typing their exact username,
 * which works for the student in front of them and does not hand every coach a
 * searchable directory of the academy's children.
 *
 * The server is the authority on all of this, not this file: `POST /api/classes`
 * 404s a batch the coach does not own, `PATCH /api/batches/[id]` refuses a
 * `coachUserId` from a coach, and HR/HEAD are unscoped so the head can override
 * any of it. Hiding a control here only avoids offering a button that would fail.
 */
export default function ScheduleClient({ role }: { role: string }) {
  const isManager = role === "HR" || role === "HEAD";

  const [batches, setBatches] = useState<Batch[]>([]);
  const [coaches, setCoaches] = useState<UserLite[]>([]);
  const [students, setStudents] = useState<UserLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // New-batch form
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCoach, setNewCoach] = useState("");
  const [creating, setCreating] = useState(false);

  // Per-batch enroll selection. Staff pick an id from the dropdown; a coach types
  // a username, so the same map holds either and the request sends whichever the
  // role produced.
  const [enrollSel, setEnrollSel] = useState<Record<string, string>>({});
  const [enrollMsg, setEnrollMsg] = useState<Record<string, string>>({});

  // Schedule-class modal
  const [modalBatch, setModalBatch] = useState<Batch | null>(null);
  const [clsTitle, setClsTitle] = useState("");
  const [clsDesc, setClsDesc] = useState("");
  const [clsCoach, setClsCoach] = useState("");
  const [clsStart, setClsStart] = useState("");
  const [clsEnd, setClsEnd] = useState("");
  const [clsUrl, setClsUrl] = useState("");
  const [scheduling, setScheduling] = useState(false);

  async function reloadBatches() {
    const res = await fetch("/api/batches");
    const data = await res.json();
    if (data.success) setBatches(data.batches);
  }

  useEffect(() => {
    // The roster endpoints are staff-only, so a coach must not call them — they
    // would 403 and surface as "Failed to load scheduling data." on a page that
    // is, for a coach, working perfectly. `/api/batches` already returns only
    // their own batches.
    const requests: Promise<{ success: boolean; batches?: Batch[]; users?: UserLite[] }>[] = [
      fetch("/api/batches").then((r) => r.json()),
    ];
    if (isManager) {
      requests.push(
        fetch("/api/users?role=COACH").then((r) => r.json()),
        fetch("/api/users?role=STUDENT").then((r) => r.json()),
      );
    }
    Promise.all(requests)
      .then(([b, c, s]) => {
        if (b?.success) setBatches(b.batches ?? []);
        if (c?.success) setCoaches(c.users ?? []);
        if (s?.success) setStudents(s.users ?? []);
      })
      .catch(() => setError("Failed to load scheduling data."))
      .finally(() => setLoading(false));
  }, [isManager]);

  async function createBatch(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, description: newDesc || undefined, coachUserId: newCoach || undefined }),
      });
      if (res.ok) {
        setNewName("");
        setNewDesc("");
        setNewCoach("");
        await reloadBatches();
      }
    } finally {
      setCreating(false);
    }
  }

  async function assignCoach(batchId: string, coachUserId: string) {
    if (!coachUserId) return;
    await fetch(`/api/batches/${batchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coachUserId }),
    });
    await reloadBatches();
  }

  async function enroll(batchId: string) {
    const value = enrollSel[batchId]?.trim();
    if (!value) return;
    setEnrollMsg((prev) => ({ ...prev, [batchId]: "" }));
    const res = await fetch(`/api/batches/${batchId}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Staff selected an id; a coach typed a name. The API takes either.
      body: JSON.stringify(isManager ? { studentUserId: value } : { username: value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setEnrollMsg((prev) => ({ ...prev, [batchId]: data.message ?? "Could not add that student." }));
      return;
    }
    setEnrollSel((prev) => ({ ...prev, [batchId]: "" }));
    setEnrollMsg((prev) => ({
      ...prev,
      [batchId]: data.alreadyEnrolled ? `${data.username} was already in this batch.` : `Added ${data.username}.`,
    }));
    await reloadBatches();
  }

  function openSchedule(batch: Batch) {
    setModalBatch(batch);
    setClsTitle("");
    setClsDesc("");
    setClsCoach(batch.coach?.userId ?? "");
    setClsStart("");
    setClsEnd("");
    setClsUrl("");
  }

  async function scheduleClass(e: React.FormEvent) {
    e.preventDefault();
    if (!modalBatch || !clsTitle.trim() || !clsStart || !clsEnd) return;
    setScheduling(true);
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: modalBatch.id,
          title: clsTitle,
          description: clsDesc || undefined,
          coachUserId: clsCoach || undefined,
          startsAt: clsStart,
          endsAt: clsEnd,
          meetingUrl: clsUrl || undefined,
        }),
      });
      if (res.ok) {
        setModalBatch(null);
        await reloadBatches();
      }
    } finally {
      setScheduling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-kca-gray-400">
        <Loader2 className="w-6 h-6 animate-spin text-kca-cyan" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Scheduling</h1>
        <p className="text-sm text-kca-gray-400">
          {isManager
            ? "Create batches, assign coaches, enroll students, and schedule classes."
            : "Schedule a session for one of your batches, whenever suits you."}
        </p>
      </div>

      {error && <div className="mb-4 rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}

      {/* A coach may form a batch, but always under their own name — the server
          ignores `coachUserId` from a coach, so the picker is staff-only. */}
      <form onSubmit={createBatch} className="card p-5 border border-kca-border bg-kca-surface mb-6 grid gap-3 md:grid-cols-4 md:items-end">
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Batch name</label>
          <input className="input-field py-2 text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="U-12 Rapid" required />
        </div>
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Description</label>
          <input className="input-field py-2 text-sm" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Optional" />
        </div>
        {isManager && (
          <div className="md:col-span-1">
            <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
            <select className={selectClass} value={newCoach} onChange={(e) => setNewCoach(e.target.value)}>
              <option value="">Unassigned</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>{c.username}</option>
              ))}
            </select>
          </div>
        )}
        <button type="submit" disabled={creating} className="btn-primary py-2.5 disabled:opacity-50">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New Batch
        </button>
      </form>

      {/* Batches */}
      {batches.length === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">
          No batches yet — create one above.
        </div>
      ) : (
        <div className="space-y-4">
          {batches.map((batch) => (
            <div key={batch.id} className="card p-5 border border-kca-border bg-kca-surface">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-kca-white">{batch.name}</div>
                  {batch.description && <div className="text-sm text-kca-gray-400 mt-0.5">{batch.description}</div>}
                  <div className="text-xs text-kca-gray-400 mt-2 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> {batch.studentCount} students · {batch.classCount} classes
                  </div>
                </div>
                <button onClick={() => openSchedule(batch)} className="btn-secondary py-2 px-4 text-sm">
                  <CalendarPlus className="w-4 h-4" /> Schedule class
                </button>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {isManager && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
                  <select className={selectClass} value={batch.coach?.userId ?? ""} onChange={(e) => assignCoach(batch.id, e.target.value)}>
                    <option value="">Unassigned</option>
                    {coaches.map((c) => (
                      <option key={c.id} value={c.id}>{c.username}</option>
                    ))}
                  </select>
                </div>
                )}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Enroll student</label>
                  <div className="flex gap-2">
                    {isManager ? (
                      <select
                        className={selectClass + " flex-1"}
                        value={enrollSel[batch.id] ?? ""}
                        onChange={(e) => setEnrollSel((prev) => ({ ...prev, [batch.id]: e.target.value }))}
                      >
                        <option value="">Select…</option>
                        {students.map((s) => (
                          <option key={s.id} value={s.id}>{s.username}</option>
                        ))}
                      </select>
                    ) : (
                      // Exact username, not a search box: a coach should be able to
                      // add the student in front of them without being handed a
                      // browsable list of every child in the academy.
                      <input
                        className="input-field flex-1 py-2 text-sm"
                        placeholder="Student's username"
                        value={enrollSel[batch.id] ?? ""}
                        onChange={(e) => setEnrollSel((prev) => ({ ...prev, [batch.id]: e.target.value }))}
                      />
                    )}
                    <button onClick={() => enroll(batch.id)} disabled={!enrollSel[batch.id]} className="btn-primary py-2 px-4 text-sm disabled:opacity-50">
                      Add
                    </button>
                  </div>
                  {enrollMsg[batch.id] && (
                    <p className="mt-1.5 text-xs text-kca-gray-400">{enrollMsg[batch.id]}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Schedule-class modal */}
      {modalBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kca-black/85 backdrop-blur-sm p-4">
          <form onSubmit={scheduleClass} className="card w-full max-w-lg bg-kca-surface border border-kca-border rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-display font-bold text-kca-white">Schedule class — {modalBatch.name}</h2>
              <button type="button" onClick={() => setModalBatch(null)} className="text-kca-gray-400 hover:text-kca-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Title</label>
              <input className="input-field py-2 text-sm" value={clsTitle} onChange={(e) => setClsTitle(e.target.value)} placeholder="Endgame technique" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Starts</label>
                <input type="datetime-local" className="input-field py-2 text-sm" value={clsStart} onChange={(e) => setClsStart(e.target.value)} required />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Ends</label>
                <input type="datetime-local" className="input-field py-2 text-sm" value={clsEnd} onChange={(e) => setClsEnd(e.target.value)} required />
              </div>
            </div>
            {isManager && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
                <select className={selectClass} value={clsCoach} onChange={(e) => setClsCoach(e.target.value)}>
                  <option value="">Use batch coach</option>
                  {coaches.map((c) => (
                    <option key={c.id} value={c.id}>{c.username}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Meeting link (optional)</label>
              <input className="input-field py-2 text-sm" value={clsUrl} onChange={(e) => setClsUrl(e.target.value)} placeholder="https://meet.google.com/…" />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setModalBatch(null)} className="text-sm font-semibold text-kca-gray-300 hover:text-kca-white px-4 py-2">Cancel</button>
              <button type="submit" disabled={scheduling} className="btn-primary py-2 px-6 disabled:opacity-50">
                {scheduling ? <Loader2 className="w-4 h-4 animate-spin" /> : "Schedule"}
              </button>
            </div>
          </form>
        </div>
      )}
      {isManager && <CoachActivity />}
    </div>
  );
}

type CoachRow = {
  userId: string;
  username: string;
  isActive: boolean;
  batches: number;
  students: number;
  completed: number;
  ongoing: number;
  scheduled: number;
  missed: number;
  total: number;
};

/**
 * How much each coach has actually taught.
 *
 * `completed` counts classes a coach explicitly ENDED, not ones whose clock ran
 * out. `missed` is the opposite — scheduled, time passed, never started. Keeping
 * them apart is the point: rolling both into one "classes held" number would hide
 * exactly the thing worth noticing.
 */
function CoachActivity() {
  const [rows, setRows] = useState<CoachRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/coach-activity")
      .then((r) => r.json())
      .then((d) => {
        if (active && d.success) setRows(d.coaches ?? []);
      })
      .catch(() => {})
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  if (!loaded || rows.length === 0) return null;

  return (
    <div className="card mt-8 p-0">
      <div className="border-b border-kca-border px-5 py-3">
        <h2 className="text-sm font-semibold text-kca-white">Coach activity</h2>
        <p className="mt-0.5 text-xs text-kca-gray-400">
          Classes each coach has finished, has coming up, and scheduled but never started.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-kca-border text-left text-xs uppercase tracking-wider text-kca-gray-400">
              <th className="px-5 py-3">Coach</th>
              <th className="px-3 py-3 text-right">Completed</th>
              <th className="px-3 py-3 text-right">Live</th>
              <th className="px-3 py-3 text-right">Upcoming</th>
              <th className="px-3 py-3 text-right">Not started</th>
              <th className="px-3 py-3 text-right">Batches</th>
              <th className="px-5 py-3 text-right">Students</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.userId} className="border-b border-kca-border/50 last:border-0">
                <td className="px-5 py-3 text-kca-white">
                  {c.username}
                  {!c.isActive && <span className="ml-2 text-xs text-kca-gray-500">(inactive)</span>}
                </td>
                <td className="px-3 py-3 text-right font-mono text-kca-success">{c.completed}</td>
                <td className="px-3 py-3 text-right font-mono text-kca-gray-100">{c.ongoing}</td>
                <td className="px-3 py-3 text-right font-mono text-kca-gray-100">{c.scheduled}</td>
                <td className={`px-3 py-3 text-right font-mono ${c.missed > 0 ? "text-kca-warning" : "text-kca-gray-500"}`}>
                  {c.missed}
                </td>
                <td className="px-3 py-3 text-right font-mono text-kca-gray-400">{c.batches}</td>
                <td className="px-5 py-3 text-right font-mono text-kca-gray-400">{c.students}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
