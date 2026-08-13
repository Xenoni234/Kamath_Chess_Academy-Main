import type { Server, Socket } from "socket.io";
import { tournamentWatchSchema } from "../../validations/socket.ts";

/** Lets a client join a tournament's room to receive live leaderboard/round
 *  updates. Pairings are pushed to the player's personal `user:<id>` room. */
export function setupTournamentHandlers(_io: Server, socket: Socket) {
  socket.on("tournament:watch", (rawPayload: unknown) => {
    const parsed = tournamentWatchSchema.safeParse(rawPayload);
    if (!parsed.success) return;
    socket.join(`tournament:${parsed.data.tournamentId}`);
  });

  socket.on("tournament:unwatch", (rawPayload: unknown) => {
    const parsed = tournamentWatchSchema.safeParse(rawPayload);
    if (!parsed.success) return;
    socket.leave(`tournament:${parsed.data.tournamentId}`);
  });
}
