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

export default function ScheduleClient() {
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

  // Per-batch enroll selection
  const [enrollSel, setEnrollSel] = useState<Record<string, string>>({});

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
    Promise.all([
      fetch("/api/batches").then((r) => r.json()),
      fetch("/api/users?role=COACH").then((r) => r.json()),
      fetch("/api/users?role=STUDENT").then((r) => r.json()),
    ])
      .then(([b, c, s]) => {
        if (b.success) setBatches(b.batches);
        if (c.success) setCoaches(c.users);
        if (s.success) setStudents(s.users);
      })
      .catch(() => setError("Failed to load scheduling data."))
      .finally(() => setLoading(false));
  }, []);

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
    const studentUserId = enrollSel[batchId];
    if (!studentUserId) return;
    await fetch(`/api/batches/${batchId}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentUserId }),
    });
    setEnrollSel((prev) => ({ ...prev, [batchId]: "" }));
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
        <p className="text-sm text-kca-gray-400">Create batches, assign coaches, enroll students, and schedule classes.</p>
      </div>

      {error && <div className="mb-4 rounded-lg border border-kca-danger/20 bg-kca-danger/5 p-3 text-sm text-kca-danger">{error}</div>}

      {/* Create batch */}
      <form onSubmit={createBatch} className="card p-5 border border-kca-border bg-kca-surface mb-6 grid gap-3 md:grid-cols-4 md:items-end">
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Batch name</label>
          <input className="input-field py-2 text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="U-12 Rapid" required />
        </div>
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Description</label>
          <input className="input-field py-2 text-sm" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Optional" />
        </div>
        <div className="md:col-span-1">
          <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
          <select className={selectClass} value={newCoach} onChange={(e) => setNewCoach(e.target.value)}>
            <option value="">Unassigned</option>
            {coaches.map((c) => (
              <option key={c.id} value={c.id}>{c.username}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={creating} className="btn-primary py-2.5 disabled:opacity-50">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} New Batch
        </button>
      </form>

      {/* Batches */}
      {batches.length === 0 ? (
        <div className="card p-10 text-center text-kca-gray-400 border border-kca-border bg-kca-surface">No batches yet — create one above.</div>
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
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
                  <select className={selectClass} value={batch.coach?.userId ?? ""} onChange={(e) => assignCoach(batch.id, e.target.value)}>
                    <option value="">Unassigned</option>
                    {coaches.map((c) => (
                      <option key={c.id} value={c.id}>{c.username}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Enroll student</label>
                  <div className="flex gap-2">
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
                    <button onClick={() => enroll(batch.id)} disabled={!enrollSel[batch.id]} className="btn-primary py-2 px-4 text-sm disabled:opacity-50">
                      Add
                    </button>
                  </div>
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
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-1.5">Coach</label>
              <select className={selectClass} value={clsCoach} onChange={(e) => setClsCoach(e.target.value)}>
                <option value="">Use batch coach</option>
                {coaches.map((c) => (
                  <option key={c.id} value={c.id}>{c.username}</option>
                ))}
              </select>
            </div>
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
    </div>
  );
}
