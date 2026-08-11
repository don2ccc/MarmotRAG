import { useEffect, useState } from "react";
import { Database, Server, Sliders, Cpu } from "lucide-react";
import { apiFetch } from "../api";
import type { StrategyConfig } from "../types";

interface Props {
  userId: string;
  showToast: (message: string, type?: "success" | "info" | "error") => void;
}

const DEFAULT_CONFIG: StrategyConfig = {
  chunkSize: 200,
  chunkOverlap: 20,
  separationStrategy: "Semantic",
  pgHost: "127.0.0.1",
  pgPort: "5432",
  pgDatabase: "ai_hub",
  pgTable: "marmot_chunks",
  embeddingProvider: "Ollama (Local)",
  embeddingModel: "qwen3-embedding:4b",
  embeddingDimension: 2000,
  ollamaBaseUrl: "http://localhost:11434",
};

export default function WorkspaceTab({ userId, showToast }: Props) {
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [pending, setPending] = useState<StrategyConfig | null>(null);
  const [hasUnsaved, setHasUnsaved] = useState(false);

  useEffect(() => {
    apiFetch(userId, "/api/config")
      .then(r => r.json())
      .then((c: StrategyConfig) => {
        const merged = { ...DEFAULT_CONFIG, ...c };
        setConfig(merged);
        setPending(merged);
      })
      .catch(() => {});
  }, [userId]);

  const change = (key: keyof StrategyConfig, value: unknown) => {
    setPending(p => ({ ...(p ?? DEFAULT_CONFIG), [key]: value }));
    setHasUnsaved(true);
  };

  const save = async () => {
    if (!pending) return;
    try {
      const res = await apiFetch(userId, "/api/config", {
        method: "POST",
        body: JSON.stringify(pending),
      });
      if (!res.ok) throw new Error("Save config failed");
      const data = await res.json();
      setConfig(data.config);
      setPending(data.config);
      setHasUnsaved(false);
      showToast("Chunking strategy updated.", "success");
    } catch {
      showToast("Failed to update strategy config.", "error");
    }
  };

  const discard = () => {
    setPending(config);
    setHasUnsaved(false);
    showToast("Unsaved changes discarded.", "info");
  };

  if (!pending) {
    return <div className="p-10 text-center text-xs font-mono text-white/55 uppercase tracking-widest">Loading workspace…</div>;
  }

  const p = pending;
  return (
    <div className="space-y-6 p-6 md:p-8 max-w-4xl">
      <div>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Workspace Config</h2>
        <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">
          Chunking strategy · applied when documents are added or re-indexed
        </p>
      </div>

      <div className="bg-[#131720] border border-white/10 rounded-xl p-6 space-y-8">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="font-mono text-[10px] text-white/50 uppercase tracking-wider font-bold flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#86C9A4]" /> Chunk Size (tokens)
            </label>
            <span className="font-mono text-xs text-[#86C9A4] font-bold">{p.chunkSize}</span>
          </div>
          <input
            type="range" min={128} max={2048} step={16} value={p.chunkSize}
            onChange={e => change("chunkSize", Number(e.target.value))}
            className="w-full accent-[#86C9A4]"
          />
          <div className="flex justify-between font-mono text-[9px] text-white/45"><span>128</span><span>2048</span></div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="font-mono text-[10px] text-white/50 uppercase tracking-wider font-bold">Chunk Overlap (%)</label>
            <span className="font-mono text-xs text-[#86C9A4] font-bold">{p.chunkOverlap}%</span>
          </div>
          <input
            type="range" min={0} max={50} step={1} value={p.chunkOverlap}
            onChange={e => change("chunkOverlap", Number(e.target.value))}
            className="w-full accent-[#86C9A4]"
          />
          <div className="flex justify-between font-mono text-[9px] text-white/45"><span>0</span><span>50</span></div>
        </div>

        <div className="space-y-2">
          <label className="font-mono text-[10px] text-white/50 uppercase tracking-wider font-bold">Separation Strategy</label>
          <div className="grid grid-cols-3 gap-2">
            {["Semantic", "Fixed", "Recursive"].map(s => (
              <button
                key={s}
                onClick={() => change("separationStrategy", s)}
                className={`px-3 py-2.5 rounded border text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                  p.separationStrategy === s
                    ? "border-[#86C9A4] bg-[#86C9A4]/10 text-[#86C9A4]"
                    : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-[#131720] border border-white/10 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Database className="w-4 h-4 text-[#86C9A4]" />
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60">pgvector Store</h3>
          </div>
          <dl className="space-y-2 font-mono text-xs">
            <div className="flex justify-between"><dt className="text-white/55">Host</dt><dd className="text-white">{p.pgHost}:{p.pgPort}</dd></div>
            <div className="flex justify-between"><dt className="text-white/55">Database</dt><dd className="text-white">{p.pgDatabase}</dd></div>
            <div className="flex justify-between"><dt className="text-white/55">Table</dt><dd className="text-white">{p.pgTable}</dd></div>
          </dl>
        </div>
        <div className="bg-[#131720] border border-white/10 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="w-4 h-4 text-[#86C9A4]" />
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60">Embedding</h3>
          </div>
          <dl className="space-y-2 font-mono text-xs">
            <div className="flex justify-between"><dt className="text-white/55">Provider</dt><dd className="text-white">{p.embeddingProvider}</dd></div>
            <div className="flex justify-between"><dt className="text-white/55">Model</dt><dd className="text-white">{p.embeddingModel}</dd></div>
            <div className="flex justify-between"><dt className="text-white/55">Dimension</dt><dd className="text-white">{p.embeddingDimension}</dd></div>
            <div className="flex justify-between"><dt className="text-white/55">Ollama</dt><dd className="text-white">{p.ollamaBaseUrl}</dd></div>
          </dl>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] font-mono text-white/45">
        <Server className="w-3.5 h-3.5" />
        Changing chunking only affects newly indexed documents — existing docs need a re-index.
      </div>

      {hasUnsaved && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-3 bg-black border border-[#86C9A4]/40 rounded-xl px-5 py-3.5 shadow-2xl">
          <span className="font-mono text-[10px] text-white/60 uppercase tracking-wider">Unsaved changes</span>
          <button onClick={discard} className="px-3 py-1.5 border border-white/15 text-white/60 text-[10px] font-bold uppercase rounded hover:bg-white/5 cursor-pointer">
            Discard
          </button>
          <button onClick={save} className="px-4 py-1.5 bg-[#86C9A4] text-black text-[10px] font-bold uppercase rounded hover:brightness-110 cursor-pointer">
            Save
          </button>
        </div>
      )}
    </div>
  );
}
