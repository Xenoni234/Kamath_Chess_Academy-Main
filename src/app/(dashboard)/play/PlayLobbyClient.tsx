"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket/client";
import { cn } from "@/lib/utils";
import OnlinePlayers from "@/components/lobby/OnlinePlayers";

type UserRating = {
  format: string;
  rating: number;
};

type UserDetail = {
  id: string;
  username: string;
  ratings: UserRating[];
};

type Challenge = {
  challengeId: string;
  creatorId: string;
  timeControl: string;
  color: "white" | "black" | "random";
  rated: boolean;
  createdAt: number;
};

type PlayLobbyClientProps = {
  userId: string;
  username: string;
  allUsers: UserDetail[];
};

// Simple timeControl format to TimeFormat mapper
const deriveFormat = (timeControl: string) => {
  const parts = timeControl.split("+");
  const baseMinutes = parseInt(parts[0]) || 5;
  if (baseMinutes <= 2) return "BULLET";
  if (baseMinutes <= 5) return "BLITZ";
  if (baseMinutes <= 15) return "RAPID";
  return "CLASSICAL";
};

export default function PlayLobbyClient({ userId, username, allUsers }: PlayLobbyClientProps) {
  const router = useRouter();

  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([userId]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [searchingTimeControl, setSearchingTimeControl] = useState<string | null>(null);

  // Challenge modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createTimeControl, setCreateTimeControl] = useState("5+3");
  const [createColor, setCreateColor] = useState<"white" | "black" | "random">("random");
  const [createRated, setCreateRated] = useState(true);

  useEffect(() => {
    const socket = getSocket();

    // Handle online list
    socket.on("presence:online-users", (userIds: string[]) => {
      // Ensure current user is in the list
      const uniqueIds = Array.from(new Set([...userIds, userId]));
      setOnlineUserIds(uniqueIds);
    });

    socket.on("presence:user-online", ({ userId: joinedUserId }) => {
      setOnlineUserIds((prev) => Array.from(new Set([...prev, joinedUserId])));
    });

    socket.on("presence:user-offline", ({ userId: leftUserId }) => {
      setOnlineUserIds((prev) => prev.filter((id) => id !== leftUserId));
    });

    // Handle challenges
    socket.on("lobby:challenges", (updatedChallenges: Challenge[]) => {
      setChallenges(updatedChallenges);
    });

    // Handle game redirect
    socket.on("lobby:game-ready", ({ gameId }) => {
      router.push(`/game/${gameId}`);
    });

    return () => {
      socket.off("presence:online-users");
      socket.off("presence:user-online");
      socket.off("presence:user-offline");
      socket.off("lobby:challenges");
      socket.off("lobby:game-ready");
    };
  }, [router, userId]);

  const handleCreateChallenge = () => {
    const socket = getSocket();
    socket.emit("lobby:create-challenge", {
      timeControl: createTimeControl,
      color: createColor,
      rated: createRated,
    });
    setIsCreateModalOpen(false);
  };

  const handleCancelChallenge = (challengeId: string) => {
    const socket = getSocket();
    socket.emit("lobby:cancel-challenge", { challengeId });
  };

  const handleAcceptChallenge = (challengeId: string) => {
    const socket = getSocket();
    socket.emit("lobby:accept-challenge", { challengeId });
  };

  const handleQuickPair = (timeControl: string) => {
    setSearchingTimeControl(timeControl);
    const socket = getSocket();
    socket.emit("lobby:quick-pair", { timeControl });
  };

  const handleCancelQuickPair = () => {
    if (searchingTimeControl) {
      const socket = getSocket();
      socket.emit("lobby:cancel-quick-pair", { timeControl: searchingTimeControl });
      setSearchingTimeControl(null);
    }
  };

  const getCreatorDetails = (creatorId: string, timeControl: string) => {
    const user = allUsers.find((u) => u.id === creatorId);
    if (!user) return { username: "Unknown", rating: 1500 };

    const format = deriveFormat(timeControl);
    const ratingObj = user.ratings?.find((r) => r.format === format);
    return {
      username: user.username,
      rating: ratingObj ? ratingObj.rating : 1500,
    };
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-kca-border pb-5">
        <div>
          <h1 className="section-heading text-kca-white">Play Lobby</h1>
          <p className="text-kca-gray-400 text-sm mt-1">
            Challenge players, join open challenges, or match instantly.
          </p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="btn-secondary font-bold text-sm min-h-11 px-5 border border-kca-cyan hover:bg-kca-cyan/10 self-start md:self-center"
        >
          Create Challenge
        </button>
      </div>

      {/* Main 3-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: Online Players */}
        <div className="lg:col-span-3">
          <OnlinePlayers allUsers={allUsers} onlineUserIds={onlineUserIds} />
        </div>

        {/* Center Column: Open Challenges */}
        <div className="lg:col-span-6 flex flex-col">
          <div className="card h-full flex flex-col min-h-[450px]">
            <h3 className="text-lg font-bold text-kca-white mb-4 uppercase tracking-wider">
              Open Challenges
            </h3>

            <div className="flex-1 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-kca-border text-kca-gray-400 font-display text-xs font-semibold uppercase tracking-wider select-none">
                    <th className="pb-3">Player</th>
                    <th className="pb-3">Time</th>
                    <th className="pb-3">Color</th>
                    <th className="pb-3">Rating</th>
                    <th className="pb-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="text-sm font-semibold divide-y divide-kca-border">
                  {challenges.length === 0 ? (
                    <tr className="border-none">
                      <td colSpan={5} className="py-12 text-center text-kca-gray-600 italic">
                        No open challenges at the moment.
                      </td>
                    </tr>
                  ) : (
                    challenges.map((ch) => {
                      const creator = getCreatorDetails(ch.creatorId, ch.timeControl);
                      const isCreator = ch.creatorId === userId;

                      return (
                        <tr key={ch.challengeId} className="hover:bg-kca-surface-2 transition-colors">
                          <td className="py-4 text-kca-white">{creator.username}</td>
                          <td className="py-4 text-kca-cyan font-mono">{ch.timeControl}</td>
                          <td className="py-4 capitalize text-kca-gray-100">{ch.color}</td>
                          <td className="py-4 text-kca-gray-400 font-mono">{creator.rating}</td>
                          <td className="py-4 text-right">
                            {isCreator ? (
                              <button
                                onClick={() => handleCancelChallenge(ch.challengeId)}
                                className="border border-kca-danger text-kca-danger font-semibold text-xs px-4 py-1.5 rounded bg-transparent hover:bg-kca-danger/10 transition-all cursor-pointer inline-flex items-center justify-center"
                              >
                                Cancel
                              </button>
                            ) : (
                              <button
                                onClick={() => handleAcceptChallenge(ch.challengeId)}
                                className="btn-primary text-xs px-4 py-1.5 rounded cursor-pointer inline-flex items-center justify-center"
                              >
                                Accept
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Quick Pair */}
        <div className="lg:col-span-3">
          <div className="card h-full flex flex-col min-h-[450px]">
            <h3 className="text-lg font-bold text-kca-white mb-4 uppercase tracking-wider">
              Quick Pair
            </h3>

            {searchingTimeControl ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 py-8">
                {/* Searching Spinner */}
                <div className="relative w-16 h-16">
                  <div className="absolute inset-0 rounded-full border-4 border-kca-cyan/20 animate-pulse" />
                  <div className="absolute inset-0 rounded-full border-4 border-t-kca-cyan animate-spin" />
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold text-kca-white">Searching for opponent...</div>
                  <div className="text-xs text-kca-cyan mt-1 font-mono">{searchingTimeControl} • Rated</div>
                </div>
                <button
                  onClick={handleCancelQuickPair}
                  className="btn-secondary py-2 px-6 text-xs mt-2 border-kca-danger text-kca-danger hover:bg-kca-danger/10 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 flex-1">
                {[
                  { name: "Bullet", timeControl: "2+1" },
                  { name: "Blitz", timeControl: "5+0" },
                  { name: "Rapid", timeControl: "10+0" },
                  { name: "Classical", timeControl: "30+0" },
                ].map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => handleQuickPair(preset.timeControl)}
                    className="card flex flex-col items-center justify-center p-4 hover:border-kca-cyan hover:bg-kca-cyan/5 text-center transition-all duration-300 gap-3 group border border-kca-border bg-kca-black/30 cursor-pointer"
                  >
                    {/* Chess Pawn SVG Icon in Cyan */}
                    <svg
                      className="h-8 w-8 text-kca-cyan group-hover:scale-115 transition-transform duration-300"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M12 2a3 3 0 0 0-3 3c0 .87.37 1.66 1 2.21v.79A6 6 0 0 0 6 14v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1a6 6 0 0 0-4-6v-.79c.63-.55 1-1.34 1-2.21a3 3 0 0 0-3-3zM8 20h8v2H8z" />
                    </svg>
                    <div>
                      <div className="text-sm font-bold text-kca-white group-hover:text-kca-cyan transition-colors">
                        {preset.name}
                      </div>
                      <div className="text-xs text-kca-gray-400 mt-0.5">{preset.timeControl}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create Challenge Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kca-black/85 backdrop-blur-sm transition-all duration-300">
          <div className="card w-full max-w-md border border-kca-cyan shadow-cyan-md bg-kca-surface p-6 flex flex-col gap-5">
            <div className="flex justify-between items-center border-b border-kca-border pb-3">
              <h4 className="text-lg font-bold text-kca-white uppercase tracking-wider">
                Create Custom Challenge
              </h4>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-kca-gray-400 hover:text-kca-white transition-colors cursor-pointer text-lg"
              >
                ✕
              </button>
            </div>

            {/* Time Control Options */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-kca-gray-400 uppercase tracking-wide">
                Time Control
              </label>
              <div className="grid grid-cols-5 gap-2">
                {["1+0", "2+1", "3+0", "3+2", "5+0", "5+3", "10+0", "10+5", "15+10", "30+0"].map((tc) => (
                  <button
                    key={tc}
                    onClick={() => setCreateTimeControl(tc)}
                    className={cn(
                      "py-1.5 text-xs font-semibold rounded border transition-all duration-300 cursor-pointer",
                      createTimeControl === tc
                        ? "bg-kca-cyan text-kca-black border-kca-cyan font-bold"
                        : "bg-kca-black border-kca-border text-kca-gray-100 hover:border-kca-cyan/40"
                    )}
                  >
                    {tc}
                  </button>
                ))}
              </div>
            </div>

            {/* Color selection */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-kca-gray-400 uppercase tracking-wide">
                Color Preference
              </label>
              <div className="grid grid-cols-3 gap-2">
                {["white", "random", "black"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCreateColor(c as any)}
                    className={cn(
                      "py-2 text-xs font-semibold rounded border capitalize transition-all duration-300 cursor-pointer",
                      createColor === c
                        ? "bg-kca-cyan text-kca-black border-kca-cyan font-bold"
                        : "bg-kca-black border-kca-border text-kca-gray-100 hover:border-kca-cyan/40"
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Rated / Casual Toggle */}
            <div className="flex items-center justify-between bg-kca-black/30 p-3 rounded-lg border border-kca-border">
              <div>
                <div className="text-sm font-semibold text-kca-white">Rated Game</div>
                <div className="text-xs text-kca-gray-400">Updates Glicko ratings</div>
              </div>
              <button
                onClick={() => setCreateRated(!createRated)}
                className={cn(
                  "w-12 h-6 rounded-full p-0.5 transition-colors duration-300 focus:outline-none border border-kca-border-bright cursor-pointer flex items-center",
                  createRated ? "bg-kca-cyan" : "bg-kca-black"
                )}
              >
                <div
                  className={cn(
                    "w-4 h-4 rounded-full bg-kca-white transition-transform duration-300",
                    createRated ? "translate-x-6 bg-kca-black" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {/* Submit */}
            <button
              onClick={handleCreateChallenge}
              className="btn-primary w-full py-3 font-bold"
            >
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
