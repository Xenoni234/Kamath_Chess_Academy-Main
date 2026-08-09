"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import AnalysisBoardClient from "./AnalysisBoardClient";

// The board reads ?gameId= via useSearchParams, which Next requires to sit
// inside a Suspense boundary.
export default function AnalysisPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="w-8 h-8 animate-spin text-kca-cyan" />
        </div>
      }
    >
      <AnalysisBoardClient />
    </Suspense>
  );
}
