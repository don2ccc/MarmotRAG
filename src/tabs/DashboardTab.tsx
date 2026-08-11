import { useEffect, useState } from "react";
import { Database, Cpu, Layers, FileText, Timer, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { apiFetch } from "../api";
import type { HealthStatus, QueryLog, SystemStats } from "../types";

interface Props {
  userId: string;
}

const LOG_PAGE_SIZE = 20;

export default function DashboardTab({ userId }: Props) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [logs, setLogs] = useState<QueryLog[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadHealth = () => {
    apiFetch(userId, "/api/health").then(r => r.json()).then(setHealth).catch(() => {});
    apiFetch(userId, "/api/stats").then(r => r.json()).then(setStats).catch(() => {});
  };

  const loadLogs = (status: string, q: string, p: number) => {
    const params = new URLSearchParams({ limit: String(LOG_PAGE_SIZE), offset: String(p * LOG_PAGE_SIZE) });
    if (status) params.set("status", status);
    if (q) params.set("search", q);
    apiFetch(userId, `/api/logs?${params}`)
      .then(r => r.json())
      .then((d: { logs: QueryLog[]; total: number }) => {
        setLogs(d.logs ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadHealth();
    loadLogs(statusFilter, search, page);
    const timer = setInterval(loadHealth, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => { loadLogs(statusFilter, search, 0); setPage(0); }, [statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));

  const statCards = [
    { label: "Total Vectors", value: stats?.totalVectors ?? "—", icon: Layers },
    { label: "Visible Sources", value: stats?.activeSourceCount ?? "—", icon: FileText },
    { label: "Synced", value: stats?.syncedSourceCount ?? "—", icon: Database },
    { label: "Queries", value: stats?.queryCount ?? "—", icon: Activity },
    { label: "Avg Latency", value: stats ? `${stats.avgLatencyMs}ms` : "—", icon: Timer },
  ];

  return (
    <div className="space-y-6 p-6 md:p-8 max-w-5xl">
      <div>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Analytics Dashboard</h2>
        <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">System health · retrieval metrics · query log</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className={`bg-[#131720] border rounded-xl p-4 ${health?.pgConnected ? "border-white/10" : "border-red-500/40"}`}>
          <div className="flex items-center gap-2 mb-1">
            <Database className={`w-4 h-4 ${health?.pgConnected ? "text-[#86C9A4]" : "text-red-400"}`} />
            <span className="font-mono text-[9px] uppercase tracking-wider text-white/55 font-bold">pgvector</span>
          </div>
          <p className={`text-xs font-bold ${health?.pgConnected ? "text-[#86C9A4]" : "text-red-400"}`}>
            {health?.pgConnected ? "CONNECTED" : "OFFLINE"}
          </p>
        </div>
        <div className={`bg-[#131720] border rounded-xl p-4 ${health?.ollamaConnected ? "border-white/10" : "border-red-500/40"}`}>
          <div className="flex items-center gap-2 mb-1">
            <Cpu className={`w-4 h-4 ${health?.ollamaConnected ? "text-[#86C9A4]" : "text-red-400"}`} />
            <span className="font-mono text-[9px] uppercase tracking-wider text-white/55 font-bold">Ollama</span>
          </div>
          <p className={`text-xs font-bold ${health?.ollamaConnected ? "text-[#86C9A4]" : "text-red-400"}`}>
            {health?.ollamaConnected ? "CONNECTED" : "OFFLINE"}
          </p>
        </div>
        <div className="bg-[#131720] border border-white/10 rounded-xl p-4 col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-white/55" />
            <span className="font-mono text-[9px] uppercase tracking-wider text-white/55 font-bold">Mode</span>
          </div>
          <p className="text-xs font-bold text-white">RETRIEVAL-ONLY</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {statCards.map(c => (
          <div key={c.label} className="bg-[#131720] border border-white/10 rounded-xl p-4">
            <c.icon className="w-4 h-4 text-[#86C9A4] mb-2" />
            <p className="font-display text-xl font-extrabold text-white">{c.value}</p>
            <p className="font-mono text-[9px] text-white/55 uppercase tracking-wider mt-1">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/10">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60">Query Log</h3>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-[#0E1218] border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4] cursor-pointer"
            >
              <option value="">All status</option>
              <option value="success">success</option>
              <option value="error">error</option>
            </select>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search queries…"
              className="bg-[#0E1218] border border-white/10 rounded px-2.5 py-1.5 text-[10px] font-mono text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] w-40"
            />
          </div>
        </div>

        {logs.length === 0 ? (
          <p className="text-center py-10 text-xs font-mono text-white/45">No queries yet.</p>
        ) : (
          <div>
            {logs.map(l => {
              const open = !!expanded[l.id];
              return (
                <div key={l.id} className="border-b border-white/5 last:border-0">
                  <button
                    onClick={() => setExpanded(e => ({ ...e, [l.id]: !open }))}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors cursor-pointer text-left"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${l.status === "success" ? "bg-[#86C9A4]" : "bg-red-400"}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-white truncate">{l.query}</p>
                      <p className="font-mono text-[9px] text-white/45">
                        {l.via} · {new Date(l.timestamp).toLocaleString()} · {l.latencyMs}ms
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-white/55 shrink-0">{l.retrievedChunks.length} chunks</span>
                    {open ? <ChevronUp className="w-4 h-4 text-white/45 shrink-0" /> : <ChevronDown className="w-4 h-4 text-white/45 shrink-0" />}
                  </button>
                  {open && (
                    <div className="px-4 pb-4 space-y-2">
                      {l.retrievedChunks.length === 0 ? (
                        <p className="text-[11px] font-mono text-white/45">No chunks retrieved.</p>
                      ) : l.retrievedChunks.map((c, i) => (
                        <div key={`${l.id}-${i}`} className="bg-black/50 border border-white/5 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-[9px] text-[#86C9A4] uppercase font-bold">{c.sourceName}</span>
                            <span className="font-mono text-[9px] text-white/45">{c.score.toFixed(4)}</span>
                          </div>
                          <p className="text-[11px] text-white/60 font-mono leading-relaxed line-clamp-3">{c.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
          <span className="font-mono text-[9px] text-white/45">{total} entries</span>
          <div className="flex items-center gap-2">
            <button
              disabled={page === 0}
              onClick={() => { const p = page - 1; setPage(p); loadLogs(statusFilter, search, p); }}
              className="px-3 py-1.5 border border-white/10 text-white/60 text-[10px] font-bold rounded hover:bg-white/5 disabled:opacity-30 cursor-pointer"
            >Prev</button>
            <span className="font-mono text-[10px] text-white/55">{(page + 1)} / {totalPages}</span>
            <button
              disabled={page + 1 >= totalPages}
              onClick={() => { const p = page + 1; setPage(p); loadLogs(statusFilter, search, p); }}
              className="px-3 py-1.5 border border-white/10 text-white/60 text-[10px] font-bold rounded hover:bg-white/5 disabled:opacity-30 cursor-pointer"
            >Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
