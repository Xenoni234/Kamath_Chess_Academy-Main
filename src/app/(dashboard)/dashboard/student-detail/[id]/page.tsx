"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";

type Overview = {
  student: { id: string; username: string; email: string; createdAt: string };
  ratings: { format: string; rating: number }[];
  games: {
    id: string;
    result: string;
    timeFormat: string;
    playedAt: string;
    whiteUser: { id: string; username: string } | null;
    blackUser: { id: string; username: string } | null;
  }[];
  reports: { id: string; status: string; gamesAnalyzed: number; createdAt: string }[];
  batches: ({ id: string; name: string } | null)[];
  classes: ({ id: string; title: string; startsAt: string; status: string } | null)[];
  attendance: { id: string; status: string; markedAt: string; class: { id: string; title: string } | null }[];
  attendanceSummary: { total: number; present: number; rate: number | null };
  payments: {
    id: string;
    amount: number;
    status: string;
    method: string | null;
    description: string | null;
    dueDate: string | null;
    paidAt: string | null;
  }[];
};

const STATUS_TONE: Record<string, string> = {
  PRESENT: "text-kca-success",
  LATE: "text-kca-warning",
  ABSENT: "text-kca-danger",
  EXCUSED: "text-kca-gray-400",
  COMPLETED: "text-kca-success",
  PENDING: "text-kca-warning",
  FAILED: "text-kca-danger",
  REFUNDED: "text-kca-gray-400",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-kca-gray-400">{title}</h2>
      {children}
    </section>
  );
}

/** One student's progress, for whoever is allowed to see it. The API enforces
 *  that (self / own child / own student / staff) and audits third-party reads. */
export default function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/students/${id}/overview`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message ?? "Not found");
          return;
        }
        setData(json);
      } catch {
        setError("Could not load this student.");
      }
    })();
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-kca-danger">{error}</p>
        <Link href="/dashboard" className="btn-secondary mt-4 inline-block">← Back</Link>
      </div>
    );
  }
  if (!data) return <div className="mx-auto max-w-3xl px-4 py-10 text-kca-gray-400">Loading…</div>;

  const { student, ratings, games, reports, batches, classes, attendance, attendanceSummary, payments } = data;
  const outstanding = payments.filter((p) => p.status === "PENDING").reduce((sum, p) => sum + p.amount, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="section-heading">{student.username}</h1>
      <p className="section-subheading mb-6">{student.email}</p>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-kca-gray-400">Top rating</div>
          <div className="mt-1 text-2xl font-semibold text-kca-white">{ratings[0]?.rating ?? "—"}</div>
          <div className="text-xs text-kca-gray-500">{ratings[0]?.format.toLowerCase() ?? "unrated"}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-kca-gray-400">Attendance</div>
          <div className="mt-1 text-2xl font-semibold text-kca-white">
            {attendanceSummary.rate === null ? "—" : `${attendanceSummary.rate}%`}
          </div>
          <div className="text-xs text-kca-gray-500">{attendanceSummary.total} classes marked</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-kca-gray-400">Outstanding</div>
          <div className={`mt-1 text-2xl font-semibold ${outstanding > 0 ? "text-kca-warning" : "text-kca-white"}`}>
            ₹{outstanding.toLocaleString("en-IN")}
          </div>
          <div className="text-xs text-kca-gray-500">{payments.length} entries</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent games">
          {games.length === 0 ? (
            <p className="text-sm text-kca-gray-400">No games yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {games.map((g) => (
                <li key={g.id}>
                  {/* Opens the analysis board on this game, where a coach can
                      annotate individual moves. The id was already here; there
                      was simply no way to get from it to the board. */}
                  <Link
                    href={`/dashboard/analysis?gameId=${g.id}`}
                    className="flex items-center justify-between gap-2 rounded px-1 py-0.5 transition hover:bg-kca-surface-2"
                  >
                    <span className="truncate text-kca-gray-100">
                      {g.whiteUser?.username ?? "?"} vs {g.blackUser?.username ?? "?"}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-kca-gray-500">
                      {g.result} · {new Date(g.playedAt).toLocaleDateString("en-IN")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Attendance history">
          {attendance.length === 0 ? (
            <p className="text-sm text-kca-gray-400">Nothing marked yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {attendance.slice(0, 10).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-kca-gray-100">{a.class?.title ?? "Class"}</span>
                  <span className={`shrink-0 text-xs font-medium ${STATUS_TONE[a.status] ?? ""}`}>{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Classes & batches">
          <div className="space-y-2 text-sm text-kca-gray-100">
            <div>
              <span className="text-kca-gray-400">Batches: </span>
              {batches.filter(Boolean).length
                ? [...new Set(batches.filter(Boolean).map((b) => b!.name))].join(", ")
                : "None"}
            </div>
            <div>
              <span className="text-kca-gray-400">Upcoming: </span>
              {classes.filter(Boolean).length
                ? classes.filter(Boolean).slice(0, 3).map((c) => c!.title).join(", ")
                : "None scheduled"}
            </div>
          </div>
        </Card>

        <Card title="Fees">
          {payments.length === 0 ? (
            <p className="text-sm text-kca-gray-400">No fee records.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {payments.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-kca-gray-100">{p.description ?? "Fee"}</span>
                  <span className="shrink-0 text-xs">
                    <span className="font-mono text-kca-gray-100">₹{p.amount.toLocaleString("en-IN")}</span>{" "}
                    <span className={STATUS_TONE[p.status] ?? ""}>{p.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Game reports">
          {reports.length === 0 ? (
            <p className="text-sm text-kca-gray-400">No reports generated.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {reports.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="text-kca-gray-100">{r.gamesAnalyzed} games</span>
                  <span className="shrink-0 text-xs text-kca-gray-500">
                    {r.status} · {new Date(r.createdAt).toLocaleDateString("en-IN")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
