import type { PrismaClient, TimeFormat } from "@prisma/client";
import { Glicko2 } from "glicko2";

type RatingRecord = {
  userId: string;
  rating: number;
  rd: number;
  sigma: number;
};

async function getOrCreateRating(db: PrismaClient, userId: string, format: TimeFormat): Promise<RatingRecord> {
  const rating = await db.rating.upsert({
    where: { userId_format: { userId, format } },
    create: { userId, format, rating: 1500, rd: 350, sigma: 0.06 },
    update: {},
  });

  return {
    userId,
    rating: rating.rating,
    rd: rating.rd,
    sigma: rating.sigma,
  };
}

export async function updateRatings(params: {
  winnerId: string | null;
  loserId: string | null;
  drawPlayerIds?: [string, string];
  format: TimeFormat;
  db: PrismaClient;
}): Promise<void> {
  const playerIds =
    params.drawPlayerIds ??
    (params.winnerId && params.loserId ? ([params.winnerId, params.loserId] as [string, string]) : null);

  if (!playerIds) {
    throw new Error("Rated game requires either winner/loser ids or draw player ids.");
  }

  const [firstRating, secondRating] = await Promise.all([
    getOrCreateRating(params.db, playerIds[0], params.format),
    getOrCreateRating(params.db, playerIds[1], params.format),
  ]);

  const glicko2 = new Glicko2();
  const first = glicko2.makePlayer(firstRating.rating, firstRating.rd, firstRating.sigma);
  const second = glicko2.makePlayer(secondRating.rating, secondRating.rd, secondRating.sigma);

  if (params.drawPlayerIds) {
    first.addResult(second, 0.5);
  } else if (params.winnerId === firstRating.userId) {
    first.addResult(second, 1);
  } else {
    second.addResult(first, 1);
  }

  glicko2.calculatePlayersRatings();

  await Promise.all([
    params.db.rating.update({
      where: { userId_format: { userId: firstRating.userId, format: params.format } },
      data: {
        rating: Math.round(first.getRating()),
        rd: first.getRd(),
        sigma: first.getVol(),
      },
    }),
    params.db.rating.update({
      where: { userId_format: { userId: secondRating.userId, format: params.format } },
      data: {
        rating: Math.round(second.getRating()),
        rd: second.getRd(),
        sigma: second.getVol(),
      },
    }),
  ]);
}
