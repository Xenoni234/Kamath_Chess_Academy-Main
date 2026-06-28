"use client";

import Link from "next/link";

type UserRating = {
  format: string;
  rating: number;
};

type UserDetail = {
  id: string;
  username: string;
  ratings: UserRating[];
};

type OnlinePlayersProps = {
  allUsers: UserDetail[];
  onlineUserIds: string[];
};

export default function OnlinePlayers({ allUsers, onlineUserIds }: OnlinePlayersProps) {
  const getBlitzRating = (user: UserDetail) => {
    const ratingObj = user.ratings?.find((r) => r.format === "BLITZ");
    return ratingObj ? ratingObj.rating : 1500;
  };

  // Find users in allUsers list that are currently online
  const onlineUsers = allUsers.filter((user) => onlineUserIds.includes(user.id));

  return (
    <div className="card h-full flex flex-col min-h-[450px]">
      <h3 className="text-lg font-bold text-kca-white mb-4 uppercase tracking-wider">
        Online Players
      </h3>

      {/* Online Badge */}
      <div className="flex items-center gap-2 mb-4 bg-kca-black/40 p-3 rounded-lg border border-kca-border select-none">
        <span className="h-2.5 w-2.5 rounded-full bg-kca-success animate-pulse" />
        <span className="text-xs font-semibold text-kca-gray-100">
          {onlineUserIds.length} Player{onlineUserIds.length !== 1 ? "s" : ""} Online
        </span>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[350px]">
        {onlineUsers.length === 0 ? (
          <div className="text-kca-gray-600 text-sm text-center py-8 italic select-none">
            No other players online.
          </div>
        ) : (
          onlineUsers.map((user) => (
            <Link
              key={user.id}
              href={`/dashboard/profile/${user.id}`}
              onClick={(e) => {
                // Prevent routing since profiles are Phase 2 placeholders
                e.preventDefault();
              }}
              className="flex items-center justify-between p-2.5 rounded-lg border border-kca-border/40 hover:border-kca-cyan/40 bg-kca-black/20 hover:bg-kca-cyan/5 transition-all duration-300 group cursor-default"
            >
              <div className="flex items-center gap-3">
                {/* Avatar Placeholder */}
                <div className="h-9 w-9 rounded-full bg-kca-border group-hover:bg-kca-cyan/10 border border-kca-border-bright group-hover:border-kca-cyan/30 flex items-center justify-center text-sm font-bold text-kca-cyan transition-all duration-300">
                  {user.username[0]?.toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-semibold text-kca-white group-hover:text-kca-cyan transition-colors">
                    {user.username}
                  </div>
                  <div className="text-xs text-kca-gray-400">
                    Blitz • {getBlitzRating(user)}
                  </div>
                </div>
              </div>

              {/* Status Indicator */}
              <span className="h-2 w-2 rounded-full bg-kca-success" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
