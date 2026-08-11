import { useState } from "react";
import type { FormEvent } from "react";
import { Search, Timer, FileText, Hash, ChevronDown, ChevronUp } from "lucide-react";
import { apiFetch } from "../api";
import type { RetrieveResult } from "../types";

interface Props {
  userId: string;
  showToast: (message: string, type?: "success" | "info" | "error") => void;
}

export default function PlaygroundTab({ userId, showToast }: Props) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [minScore, setMinScore] = useState(0);
  const [isQuerying, setIsQuerying] = useState(false);
  const [result, setResult] = useState<RetrieveResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setIsQuerying(true);
    setResult(null);
    try {
      const res = await apiFetch(userId, "/api/retrieve", {
        method: "POST",
        body: JSON.stringify({ query, topK, minScore }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Retrieval failed");
      }
      const data: RetrieveResult = await res.json();
      setResult(data);
      setExpanded({});
      showToast(data.chunks.length > 0 ? `Retrieved ${data.chunks.length} chunk(s).` : "No chunks matched.", data.chunks.length > 0 ? "success" : "info");
    } catch (err: any) {
      showToast(err.message || "Failed to retrieve. Is Ollama running?", "error");
    } finally {
      setIsQuerying(false);
    }
  };

  return (
    <div className="space-y-6 p-6 md:p-8 max-w-4xl">
      <div>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Retrieval Lab</h2>
        <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">
          Ask a question → see the most relevant chunks from documents you can access
        </p>
      </div>

      <form onSubmit={run} className="bg-[#131720] border border-white/10 rounded-xl p-5 space-y-4">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/45" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="e.g. 2024年国巨集团的毛利率是多少？"
            className="w-full pl-10 pr-4 py-3 bg-[#0E1218] border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] font-sans"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="space-y-1.5">
            <span className="flex justify-between font-mono text-[10px] text-white/50 uppercase tracking-wider">
              <span>Top K</span><span className="text-[#86C9A4] font-bold">{topK}</span>
            </span>
            <input type="range" min={1} max={20} value={topK} onChange={e => setTopK(Number(e.target.value))} className="w-full accent-[#86C9A4]" />
          </label>
          <label className="space-y-1.5">
            <span className="flex justify-between font-mono text-[10px] text-white/50 uppercase tracking-wider">
              <span>Min Score</span><span className="text-[#86C9A4] font-bold">{minScore.toFixed(2)}</span>
            </span>
            <input type="range" min={0} max={1} step={0.05} value={minScore} onChange={e => setMinScore(Number(e.target.value))} className="w-full accent-[#86C9A4]" />
          </label>
        </div>
        <button
          type="submit" disabled={isQuerying || !query.trim()}
          className="w-full py-3 bg-[#86C9A4] text-black text-xs font-bold uppercase tracking-widest rounded-lg hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {isQuerying ? "Retrieving…" : "Retrieve Chunks"}
        </button>
      </form>

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="bg-[#131720] border border-white/10 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <Hash className="w-4 h-4 text-[#86C9A4]" />
              <span className="font-mono text-xs text-white font-bold">{result.chunks.length}</span>
              <span className="font-mono text-[9px] text-white/55 uppercase">chunks</span>
            </div>
            <div className="bg-[#131720] border border-white/10 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <Timer className="w-4 h-4 text-[#86C9A4]" />
              <span className="font-mono text-xs text-white font-bold">{result.latencyMs}</span>
              <span className="font-mono text-[9px] text-white/55 uppercase">ms</span>
            </div>
          </div>

          {result.chunks.length === 0 ? (
            <div className="bg-[#131720] border border-white/10 rounded-xl p-8 text-center">
              <FileText className="w-6 h-6 text-white/20 mx-auto mb-3" />
              <p className="text-xs text-white/55 font-mono">No chunks matched. Try lowering Min Score or check that documents are Synced.</p>
            </div>
          ) : result.chunks.map((c, i) => {
            const open = !!expanded[c.chunkId];
            return (
              <div key={c.chunkId} className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpanded(e => ({ ...e, [c.chunkId]: !open }))}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors cursor-pointer text-left"
                >
                  <span className="font-mono text-[9px] text-white/45 w-6">#{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white truncate">{c.sourceName}</p>
                    <p className="font-mono text-[9px] text-white/45 truncate">{c.chunkId} · {c.tokenCount} tokens</p>
                  </div>
                  <span className={`px-2 py-1 rounded font-mono text-[10px] font-bold ${
                    c.score >= 0.7 ? "bg-[#86C9A4]/15 text-[#86C9A4]" :
                    c.score >= 0.4 ? "bg-yellow-500/15 text-yellow-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {c.score.toFixed(4)}
                  </span>
                  {open ? <ChevronUp className="w-4 h-4 text-white/45" /> : <ChevronDown className="w-4 h-4 text-white/45" />}
                </button>
                {open && (
                  <p className="px-4 pb-4 pt-1 text-xs text-white/70 font-mono leading-relaxed whitespace-pre-wrap border-t border-white/5">
                    {c.text}
                  </p>
                )}
              </div>
            );
          })}

          {result.chunks.length > 0 && (
            <div className="bg-[#0E1218]/70 border border-white/5 rounded-xl p-4">
              <p className="font-mono text-[9px] text-white/55 uppercase tracking-wider mb-2 font-bold">Pre-assembled context (for external LLM prompts)</p>
              <p className="text-[11px] text-white/50 font-mono leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">{result.context}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
