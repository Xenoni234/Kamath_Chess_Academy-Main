"use client";

import Link from "next/link";
import { Map, ArrowLeft } from "lucide-react";

export default function OpeningsPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
      <div className="w-20 h-20 rounded-2xl bg-kca-cyan/10 border border-kca-cyan/30 flex items-center justify-center">
        <Map className="w-10 h-10 text-kca-cyan" />
      </div>
      <div>
        <h1 className="text-2xl font-display font-bold text-kca-white mb-2">
          Opening Explorer
        </h1>
        <p className="text-sm text-kca-gray-400 max-w-md">
          This feature is being built. Coming soon in Phase 2.
        </p>
      </div>
      <Link
        href="/dashboard/student"
        className="btn-secondary py-2 px-5 text-sm flex items-center gap-2 border border-kca-border hover:border-kca-cyan/50 hover:bg-kca-cyan/5"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>
    </div>
  );
}
