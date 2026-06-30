"use client";

import { useState } from "react";
import { FileText, Plus, FileClock, CheckCircle, ChevronRight, Download, BrainCircuit, X, Loader2 } from "lucide-react";

type ReportStatus = "completed" | "generating" | "failed";

interface Report {
  id: string;
  date: string;
  opponent: string;
  result: string;
  status: ReportStatus;
  accuracy: number;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([
    { id: "1", date: "2023-11-15", opponent: "Stockfish (Level 15)", result: "Draw", status: "completed", accuracy: 88 },
    { id: "2", date: "2023-11-12", opponent: "MagnusC", result: "Loss", status: "completed", accuracy: 74 },
    { id: "3", date: "2023-11-10", opponent: "HikaruN", result: "Win", status: "completed", accuracy: 92 },
  ]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [gamePgn, setGamePgn] = useState("");

  const handleGenerate = () => {
    if (!gamePgn.trim()) return;
    setIsGenerating(true);
    
    // Simulate generation delay
    setTimeout(() => {
       const newReport: Report = {
          id: Date.now().toString(),
          date: new Date().toISOString().split("T")[0],
          opponent: "Unknown",
          result: "Analysis",
          status: "completed",
          accuracy: Math.floor(Math.random() * 20) + 80 // random 80-100
       };
       setReports([newReport, ...reports]);
       setIsGenerating(false);
       setIsModalOpen(false);
       setGamePgn("");
    }, 3000);
  };

  return (
    <div className="p-6 w-full max-w-5xl mx-auto overflow-y-auto h-[calc(100vh-4rem)]">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-kca-white mb-2">Game Reports</h1>
          <p className="text-sm text-kca-gray-400">Deep AI analysis of your past games.</p>
        </div>
        <button onClick={() => setIsModalOpen(true)} className="btn-primary py-2 px-4 flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Report
        </button>
      </div>

      <div className="card p-0 border border-kca-border bg-kca-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-kca-gray-400 bg-kca-black/50 uppercase tracking-wider border-b border-kca-border">
              <tr>
                <th className="px-6 py-4 font-semibold">Date</th>
                <th className="px-6 py-4 font-semibold">Opponent</th>
                <th className="px-6 py-4 font-semibold">Result</th>
                <th className="px-6 py-4 font-semibold">Accuracy</th>
                <th className="px-6 py-4 font-semibold">Status</th>
                <th className="px-6 py-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kca-border/50">
              {reports.map((report) => (
                <tr key={report.id} className="hover:bg-kca-surface-2 transition-colors">
                  <td className="px-6 py-4 font-medium text-kca-white">
                    {new Date(report.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td className="px-6 py-4 text-kca-gray-300">
                    {report.opponent}
                  </td>
                  <td className="px-6 py-4">
                     <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                        report.result === "Win" ? "bg-kca-success/10 text-kca-success border border-kca-success/20" : 
                        report.result === "Loss" ? "bg-kca-error/10 text-kca-error border border-kca-error/20" : 
                        "bg-kca-gray-500/20 text-kca-gray-300 border border-kca-gray-500/30"
                     }`}>
                        {report.result}
                     </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                       <span className={`font-bold ${report.accuracy >= 90 ? "text-kca-cyan" : report.accuracy >= 80 ? "text-kca-success" : "text-kca-warning"}`}>
                          {report.accuracy}%
                       </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {report.status === "completed" && (
                       <span className="flex items-center gap-1.5 text-kca-success text-xs font-semibold">
                          <CheckCircle className="w-3 h-3" /> Completed
                       </span>
                    )}
                    {report.status === "generating" && (
                       <span className="flex items-center gap-1.5 text-kca-cyan text-xs font-semibold">
                          <Loader2 className="w-3 h-3 animate-spin" /> Analyzing
                       </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button disabled={report.status !== "completed"} className="text-kca-gray-400 hover:text-kca-cyan transition-colors disabled:opacity-50 p-2">
                       <ChevronRight className="w-5 h-5" />
                    </button>
                  </td>
                </tr>
              ))}
              
              {reports.length === 0 && (
                 <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-kca-gray-500">
                       <FileText className="w-8 h-8 mx-auto mb-3 opacity-20" />
                       <p>No game reports generated yet.</p>
                       <button onClick={() => setIsModalOpen(true)} className="text-kca-cyan text-xs hover:underline mt-2 inline-block">Generate your first report</button>
                    </td>
                 </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Generate Report Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kca-black/85 backdrop-blur-sm p-4">
          <div className="card w-full max-w-lg bg-kca-surface border border-kca-border shadow-cyan-md rounded-2xl overflow-hidden flex flex-col max-h-full">
            <div className="p-6 border-b border-kca-border flex justify-between items-center bg-kca-black/30">
              <h2 className="text-xl font-display font-bold text-kca-white flex items-center gap-2">
                 <BrainCircuit className="w-5 h-5 text-kca-cyan" /> Generate AI Report
              </h2>
              <button onClick={() => !isGenerating && setIsModalOpen(false)} className="text-kca-gray-400 hover:text-kca-white transition-colors" disabled={isGenerating}>
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
               <p className="text-sm text-kca-gray-300 mb-4 leading-relaxed">
                  Paste the PGN (Portable Game Notation) of your game below. Our AI coach will analyze the game move-by-move to calculate accuracy, identify blunders, and provide personalized advice.
               </p>
               
               <div className="mb-4">
                  <label className="block text-xs font-semibold text-kca-gray-400 uppercase tracking-wider mb-2">Game PGN</label>
                  <textarea 
                     value={gamePgn}
                     onChange={(e) => setGamePgn(e.target.value)}
                     disabled={isGenerating}
                     placeholder="[Event &quot;Live Chess&quot;]&#10;[Site &quot;Chess.com&quot;]&#10;...&#10;1. e4 e5 2. Nf3 ..."
                     className="w-full bg-kca-black/50 border border-kca-border rounded-lg p-3 text-sm text-kca-white font-mono h-40 focus:outline-none focus:border-kca-cyan transition-colors resize-none placeholder:text-kca-gray-600"
                  />
               </div>
            </div>
            
            <div className="p-6 border-t border-kca-border bg-kca-black/30 flex justify-end gap-3">
               <button 
                  onClick={() => setIsModalOpen(false)} 
                  disabled={isGenerating}
                  className="px-4 py-2 text-sm font-semibold text-kca-gray-300 hover:text-kca-white transition-colors"
               >
                  Cancel
               </button>
               <button 
                  onClick={handleGenerate} 
                  disabled={isGenerating || !gamePgn.trim()}
                  className="btn-primary py-2 px-6 flex items-center gap-2 min-w-[140px] justify-center disabled:opacity-50"
               >
                  {isGenerating ? (
                     <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
                  ) : (
                     <><FileClock className="w-4 h-4" /> Generate</>
                  )}
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
