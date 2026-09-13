import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/auth";
import { requireRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Manage the public website's content — the "Our Champions" cards and the coaching team.
 *
 * **HEAD only.** These are claims the academy makes in public about real people; saying
 * someone won a title, or is a coach here, is the owner's call and nobody else's. It is
 * also how the previous version of this content went wrong: six well-known titled players
 * were listed as "our elite academy students" in a component nobody could edit without a
 * deploy.
 *
 * Photos arrive as multipart form data and are stored as `Bytes` on the row — the same
 * pattern as the generated PDFs. The alternative was wiring up Cloudinary, whose env vars
 * have sat unused in `.env.example` since the beginning, for a dozen headshots.
 */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const achievementSchema = z.object({
  kind: z.literal("achievement"),
  id: z.string().optional(),
  name: z.string().trim().min(2).max(80),
  achievement: z.string().trim().min(4).max(200),
  achievedOn: z.string().trim().min(4),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  published: z.coerce.boolean().default(true),
});

const coachSchema = z.object({
  kind: z.literal("coach"),
  id: z.string().optional(),
  name: z.string().trim().min(2).max(80),
  title: z.string().trim().max(80).optional().or(z.literal("")),
  // 1200, not 400: a coach's credentials are a list — titles, ratings, championships,
  // awards — and the first real one entered came close to the old limit.
  bio: z.string().trim().max(1200).optional().or(z.literal("")),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  published: z.coerce.boolean().default(true),
});

function staff(request: NextRequest) {
  const token = request.cookies.get("kca_access_token")?.value;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const payload = staff(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  const denied = requireRole(payload, ["HEAD"]);
  if (denied) return denied;

  try {
    const [achievements, coaches] = await Promise.all([
      db.siteAchievement.findMany({
        orderBy: [{ displayOrder: "asc" }, { achievedOn: "desc" }],
        select: {
          id: true, name: true, achievement: true, achievedOn: true,
          displayOrder: true, published: true, photoType: true, updatedAt: true,
        },
      }),
      db.siteCoach.findMany({
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        select: {
          id: true, name: true, title: true, bio: true,
          displayOrder: true, published: true, photoType: true, updatedAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      achievements: achievements.map(({ photoType, ...r }) => ({ ...r, hasPhoto: Boolean(photoType) })),
      coaches: coaches.map(({ photoType, ...r }) => ({ ...r, hasPhoto: Boolean(photoType) })),
    });
  } catch (error) {
    console.error("[admin/site] GET failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const payload = staff(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  const denied = requireRole(payload, ["HEAD"]);
  if (denied) return denied;

  try {
    const form = await request.formData();
    const raw = Object.fromEntries(
      [...form.entries()].filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;

    const parsed =
      raw.kind === "coach" ? coachSchema.safeParse(raw) : achievementSchema.safeParse(raw);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errors[String(issue.path[0] ?? "form")] ??= issue.message;
      }
      return NextResponse.json({ success: false, message: "Please check the form", errors }, { status: 400 });
    }

    // The photo is optional on every save. Absent means "leave the existing one alone" —
    // editing a name must not silently wipe the picture.
    let photo: { photo: Uint8Array<ArrayBuffer>; photoType: string } | null = null;
    const file = form.get("photo");
    if (file && typeof file !== "string" && file.size > 0) {
      if (!ALLOWED_TYPES.has(file.type)) {
        return NextResponse.json(
          { success: false, message: "Please use a JPEG, PNG or WebP image", errors: { photo: "Unsupported image type" } },
          { status: 400 },
        );
      }
      if (file.size > MAX_PHOTO_BYTES) {
        return NextResponse.json(
          { success: false, message: "That image is too large (max 2 MB)", errors: { photo: "Max 2 MB" } },
          { status: 400 },
        );
      }
      photo = { photo: new Uint8Array(await file.arrayBuffer()), photoType: file.type };
    }

    if (parsed.data.kind === "coach") {
      const { id, name, title, bio, displayOrder, published } = parsed.data;
      const data = {
        name,
        title: title || null,
        bio: bio || null,
        displayOrder,
        published,
        ...(photo ?? {}),
      };
      const row = id
        ? await db.siteCoach.update({ where: { id }, data, select: { id: true } })
        : await db.siteCoach.create({ data, select: { id: true } });

      await writeAuditLog({
        action: id ? "site.coach.update" : "site.coach.create",
        userId: payload.userId,
        metadata: { coachId: row.id, name },
        request,
      });
      return NextResponse.json({ success: true, id: row.id });
    }

    const { id, name, achievement, achievedOn, displayOrder, published } = parsed.data;
    const when = new Date(achievedOn);
    if (Number.isNaN(when.getTime())) {
      return NextResponse.json(
        { success: false, message: "Please check the form", errors: { achievedOn: "That date is not valid" } },
        { status: 400 },
      );
    }

    const data = { name, achievement, achievedOn: when, displayOrder, published, ...(photo ?? {}) };
    const row = id
      ? await db.siteAchievement.update({ where: { id }, data, select: { id: true } })
      : await db.siteAchievement.create({ data, select: { id: true } });

    await writeAuditLog({
      action: id ? "site.achievement.update" : "site.achievement.create",
      userId: payload.userId,
      metadata: { achievementId: row.id, name },
      request,
    });
    return NextResponse.json({ success: true, id: row.id });
  } catch (error) {
    console.error("[admin/site] POST failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const payload = staff(request);
  if (!payload) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  const denied = requireRole(payload, ["HEAD"]);
  if (denied) return denied;

  try {
    const kind = request.nextUrl.searchParams.get("kind");
    const id = request.nextUrl.searchParams.get("id");
    if (!id || (kind !== "coach" && kind !== "achievement")) {
      return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
    }

    if (kind === "coach") await db.siteCoach.delete({ where: { id } });
    else await db.siteAchievement.delete({ where: { id } });

    await writeAuditLog({
      action: kind === "coach" ? "site.coach.delete" : "site.achievement.delete",
      userId: payload.userId,
      metadata: { id },
      request,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[admin/site] DELETE failed:", error);
    return NextResponse.json({ success: false, message: "Something went wrong." }, { status: 500 });
  }
}
