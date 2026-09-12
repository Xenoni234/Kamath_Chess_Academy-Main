"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

type Student = {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
  topRating: number | null;
  batches: string[];
};

/** Roster/children list. Both roles get the same card — the API decides who is
 *  in it, so neither page re-implements the relationship rules. */
export default function StudentList({ emptyMessage }: { emptyMessage: string }) {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth("/api/students");
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data.message ?? "Could not load students.");
          return;
        }
        setStudents(data.students);
      } catch {
        setError("Could not load students.");
      }
    })();
  }, []);

  if (error) return <p className="text-sm text-kca-danger">{error}</p>;
  if (!students) return <p className="text-sm text-kca-gray-400">Loading…</p>;
  if (students.length === 0) return <p className="text-sm text-kca-gray-400">{emptyMessage}</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {students.map((s) => (
        <Link
          key={s.id}
          href={`/dashboard/student-detail/${s.id}`}
          className="card flex items-center justify-between gap-3 border border-kca-border transition hover:border-kca-cyan"
        >
          <div className="min-w-0">
            <div className="truncate font-medium text-kca-white">{s.username}</div>
            <div className="truncate text-xs text-kca-gray-400">
              {s.batches.length ? s.batches.join(", ") : "No batch"}
              {s.topRating ? ` · ${s.topRating}` : ""}
            </div>
          </div>
          <span className="shrink-0 text-kca-cyan">→</span>
        </Link>
      ))}
    </div>
  );
}
