import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAccessToken } from "@/lib/auth";
import { db } from "@/lib/db";
import PlayLobbyClient from "./PlayLobbyClient";

export default async function PlayLobbyPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("kca_access_token")?.value;

  if (!token) {
    redirect("/login");
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    redirect("/login");
  }

  // The lobby only needs names/ratings to label open challenges, so this was an
  // unbounded read of every user and every rating row, serialised into the RSC
  // payload on each visit. Bounded to active accounts and a sane page size.
  const allUsers = await db.user.findMany({
    where: { isActive: true },
    orderBy: { username: "asc" },
    take: 500,
    select: {
      id: true,
      username: true,
      ratings: {
        select: {
          format: true,
          rating: true,
        },
      },
    },
  });

  return (
    <PlayLobbyClient
      userId={payload.userId}
      username={payload.username}
      allUsers={allUsers}
    />
  );
}
