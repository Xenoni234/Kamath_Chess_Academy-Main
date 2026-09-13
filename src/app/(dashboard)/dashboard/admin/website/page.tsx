"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { fetchWithAuth } from "@/lib/http/fetchWithAuth";

/**
 * Website content — the "Our Champions" strip and the coaching team on the public site.
 *
 * HEAD only. These are claims the academy makes in public about real people, and they used
 * to be hardcoded arrays that named six well-known titled players as "our elite academy
 * students". Putting them here means the person answerable for the claim is the one who
 * can change it.
 */

type Achievement = {
  id: string;
  name: string;
  achievement: string;
  achievedOn: string;
  displayOrder: number;
  published: boolean;
  hasPhoto: boolean;
  updatedAt: string;
};

type Coach = {
  id: string;
  name: string;
  title: string | null;
  bio: string | null;
  displayOrder: number;
  published: boolean;
  hasPhoto: boolean;
  updatedAt: string;
};

const EMPTY_ACHIEVEMENT = { id: "", name: "", achievement: "", achievedOn: "", displayOrder: "0", published: true };
const EMPTY_COACH = { id: "", name: "", title: "", bio: "", displayOrder: "0", published: true };

export default function WebsiteContentPage() {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ach, setAch] = useState({ ...EMPTY_ACHIEVEMENT });
  const [coach, setCoach] = useState({ ...EMPTY_COACH });
  const achPhoto = useRef<HTMLInputElement>(null);
  const coachPhoto = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/admin/site");
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not load website content.");
        return;
      }
      setAchievements(data.achievements ?? []);
      setCoaches(data.coaches ?? []);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(kind: "achievement" | "coach") {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("kind", kind);
      const fields = kind === "coach" ? coach : ach;
      for (const [k, v] of Object.entries(fields)) {
        if (k === "id" && !v) continue;
        body.set(k, String(v));
      }
      const file = (kind === "coach" ? coachPhoto : achPhoto).current?.files?.[0];
      if (file) body.set("photo", file);

      const res = await fetchWithAuth("/api/admin/site", { method: "POST", body });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not save.");
        return;
      }
      if (kind === "coach") {
        setCoach({ ...EMPTY_COACH });
        if (coachPhoto.current) coachPhoto.current.value = "";
      } else {
        setAch({ ...EMPTY_ACHIEVEMENT });
        if (achPhoto.current) achPhoto.current.value = "";
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Load an existing entry into the form above.
   *
   * The API has always supported editing — a POST carrying an `id` updates rather than
   * creates — but nothing in the UI ever set that id, so the only way to correct a typo
   * was to delete the entry and retype it, losing the photo with it.
   *
   * The file input is deliberately left empty: an absent photo on save means "keep the one
   * you have", so editing a name cannot silently wipe the picture.
   */
  function editAchievement(a: Achievement) {
    setAch({
      id: a.id,
      name: a.name,
      achievement: a.achievement,
      // `<input type="date">` wants exactly YYYY-MM-DD.
      achievedOn: a.achievedOn.slice(0, 10),
      displayOrder: String(a.displayOrder),
      published: a.published,
    });
    if (achPhoto.current) achPhoto.current.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function editCoach(c: Coach) {
    setCoach({
      id: c.id,
      name: c.name,
      title: c.title ?? "",
      bio: c.bio ?? "",
      displayOrder: String(c.displayOrder),
      published: c.published,
    });
    if (coachPhoto.current) coachPhoto.current.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(kind: "achievement" | "coach", id: string, name: string) {
    if (!confirm(`Remove "${name}" from the website?`)) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(`/api/admin/site?kind=${kind}&id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message ?? "Could not remove that.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-kca-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="section-heading">Website</h1>
      <p className="section-subheading mb-6">
        What visitors see on the public site. Add as many as you like — both strips scroll.
      </p>

      {error && <p className="mb-4 text-sm text-kca-danger">{error}</p>}

      {/* ---- Champions --------------------------------------------------- */}
      <section className="card mb-8">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-kca-white">
          Our Champions ({achievements.length})
        </h2>

        {ach.id && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-kca-cyan/30 bg-kca-cyan/5 px-4 py-2.5">
            <p className="text-xs text-kca-gray-100">
              Editing <strong className="text-kca-white">{ach.name || "this entry"}</strong>. Leave the
              photo empty to keep the current one.
            </p>
            <button
              type="button"
              onClick={() => {
                setAch({ ...EMPTY_ACHIEVEMENT });
                if (achPhoto.current) achPhoto.current.value = "";
              }}
              className="flex shrink-0 items-center gap-1 text-xs text-kca-gray-400 hover:text-kca-white"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        )}

        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          <input
            className="input-field"
            placeholder="Student's name"
            value={ach.name}
            onChange={(e) => setAch((v) => ({ ...v, name: e.target.value }))}
          />
          <input
            type="date"
            className="input-field"
            value={ach.achievedOn}
            onChange={(e) => setAch((v) => ({ ...v, achievedOn: e.target.value }))}
          />
          <input
            className="input-field sm:col-span-2"
            placeholder="What they achieved — e.g. Won Gold at the State Under-13"
            value={ach.achievement}
            onChange={(e) => setAch((v) => ({ ...v, achievement: e.target.value }))}
          />
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              Photo (optional, max 2 MB)
            </label>
            <input ref={achPhoto} type="file" accept="image/jpeg,image/png,image/webp" className="input-field text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">Order</label>
            <input
              type="number"
              className="input-field"
              value={ach.displayOrder}
              onChange={(e) => setAch((v) => ({ ...v, displayOrder: e.target.value }))}
            />
          </div>
          <button
            type="button"
            onClick={() => save("achievement")}
            disabled={busy || !ach.name.trim() || !ach.achievement.trim() || !ach.achievedOn}
            className="btn-primary sm:col-span-2 disabled:opacity-50"
          >
            {ach.id ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {ach.id ? "Save changes" : "Add champion"}
          </button>
        </div>

        {achievements.length === 0 ? (
          <p className="text-sm text-kca-gray-400">
            None yet — the section stays hidden on the public site until you add one.
          </p>
        ) : (
          <ul className="divide-y divide-kca-border">
            {achievements.map((a) => (
              <li key={a.id} className="flex items-center gap-4 py-3">
                {a.hasPhoto ? (
                  <Image
                    src={`/api/public/photo/achievement/${a.id}?v=${a.updatedAt}`}
                    alt=""
                    width={40}
                    height={40}
                    unoptimized
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-kca-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-kca-white">{a.name}</p>
                  <p className="truncate text-xs text-kca-gray-400">{a.achievement}</p>
                </div>
                {!a.published && <span className="text-xs text-kca-warning">hidden</span>}
                <button
                  type="button"
                  onClick={() => editAchievement(a)}
                  disabled={busy}
                  aria-label={`Edit ${a.name}`}
                  className="text-kca-cyan hover:opacity-70 disabled:opacity-40"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove("achievement", a.id, a.name)}
                  disabled={busy}
                  aria-label={`Remove ${a.name}`}
                  className="text-kca-danger hover:opacity-70 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Coaches ----------------------------------------------------- */}
      <section className="card">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-kca-white">
          Our Coaches ({coaches.length})
        </h2>

        {coach.id && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-kca-cyan/30 bg-kca-cyan/5 px-4 py-2.5">
            <p className="text-xs text-kca-gray-100">
              Editing <strong className="text-kca-white">{coach.name || "this coach"}</strong>. Leave the
              photo empty to keep the current one.
            </p>
            <button
              type="button"
              onClick={() => {
                setCoach({ ...EMPTY_COACH });
                if (coachPhoto.current) coachPhoto.current.value = "";
              }}
              className="flex shrink-0 items-center gap-1 text-xs text-kca-gray-400 hover:text-kca-white"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        )}

        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          <input
            className="input-field"
            placeholder="Coach's name"
            value={coach.name}
            onChange={(e) => setCoach((v) => ({ ...v, name: e.target.value }))}
          />
          <input
            className="input-field"
            placeholder="Title — e.g. Head Coach"
            value={coach.title}
            onChange={(e) => setCoach((v) => ({ ...v, title: e.target.value }))}
          />
          <textarea
            className="input-field resize-none sm:col-span-2"
            rows={2}
            placeholder="A sentence or two about them"
            value={coach.bio}
            onChange={(e) => setCoach((v) => ({ ...v, bio: e.target.value }))}
          />
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">
              Photo (optional, max 2 MB)
            </label>
            <input ref={coachPhoto} type="file" accept="image/jpeg,image/png,image/webp" className="input-field text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-kca-gray-400">Order</label>
            <input
              type="number"
              className="input-field"
              value={coach.displayOrder}
              onChange={(e) => setCoach((v) => ({ ...v, displayOrder: e.target.value }))}
            />
          </div>
          <button
            type="button"
            onClick={() => save("coach")}
            disabled={busy || !coach.name.trim()}
            className="btn-primary sm:col-span-2 disabled:opacity-50"
          >
            {coach.id ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {coach.id ? "Save changes" : "Add coach"}
          </button>
        </div>

        {coaches.length === 0 ? (
          <p className="text-sm text-kca-gray-400">
            None yet — the section stays hidden on the public site until you add one. The
            &ldquo;Coaches&rdquo; figure in the homepage stats counts these, so it matches the faces below it.
          </p>
        ) : (
          <ul className="divide-y divide-kca-border">
            {coaches.map((c) => (
              <li key={c.id} className="flex items-center gap-4 py-3">
                {c.hasPhoto ? (
                  <Image
                    src={`/api/public/photo/coach/${c.id}?v=${c.updatedAt}`}
                    alt=""
                    width={40}
                    height={40}
                    unoptimized
                    className="h-10 w-10 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded-full bg-kca-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-kca-white">{c.name}</p>
                  <p className="truncate text-xs text-kca-gray-400">{c.title ?? "—"}</p>
                </div>
                {!c.published && <span className="text-xs text-kca-warning">hidden</span>}
                <button
                  type="button"
                  onClick={() => editCoach(c)}
                  disabled={busy}
                  aria-label={`Edit ${c.name}`}
                  className="text-kca-cyan hover:opacity-70 disabled:opacity-40"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove("coach", c.id, c.name)}
                  disabled={busy}
                  aria-label={`Remove ${c.name}`}
                  className="text-kca-danger hover:opacity-70 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
