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

  const allUsers = await db.user.findMany({
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
