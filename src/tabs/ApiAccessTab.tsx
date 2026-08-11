import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Key, Plus, Copy, Check, Trash2, Zap, CalendarClock, Activity, ToggleLeft, ToggleRight, Code2, BookOpen } from "lucide-react";
import { apiFetch } from "../api";
import type { AgentApiKeyCreated, AgentApiKeyPublic, SourceDoc } from "../types";

interface Props {
  userId: string;
  sources: SourceDoc[];
  showToast: (message: string, type?: "success" | "info" | "error") => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

export default function ApiAccessTab({ userId, sources, showToast, showConfirm }: Props) {
  const [keys, setKeys] = useState<AgentApiKeyPublic[]>([]);
  const [isNewKeyOpen, setIsNewKeyOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    apiFetch(userId, "/api/agent/keys").then(r => r.json()).then(setKeys).catch(() => {});
  };

  useEffect(() => { refresh(); }, [userId]);

  const visibleSources = useMemo(
    () => sources.filter(s => s.ownerId === userId || s.isShared),
    [sources, userId]
  );

  const totals = useMemo(() => ({
    calls: keys.reduce((s, k) => s + k.usageCount, 0),
    month: keys.reduce((s, k) => s + k.usageThisMonth, 0),
    active: keys.filter(k => k.enabled).length,
  }), [keys]);

  const toggleSource = (id: string) => {
    setSourceFilter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const createKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    try {
      const res = await apiFetch(userId, "/api/agent/keys", {
        method: "POST",
        body: JSON.stringify({ label, rateLimit, sourceFilter }),
      });
      if (!res.ok) throw new Error("Failed to create key");
      const data: AgentApiKeyCreated = await res.json();
      setSecret(data.key);
      const { key: _s, ...pub } = data;
      setKeys(prev => [...prev, pub]);
      setLabel(""); setRateLimit(60); setSourceFilter([]);
      setIsNewKeyOpen(false);
      showToast("API key created. Copy the secret now — it won't be shown again.", "success");
    } catch {
      showToast("Failed to create API key.", "error");
    }
  };

  const toggleKey = async (id: string, enabled: boolean) => {
    try {
      const res = await apiFetch(userId, `/api/agent/keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error();
      setKeys(prev => prev.map(k => k.id === id ? { ...k, enabled } : k));
      showToast(enabled ? "API key enabled." : "API key disabled.", "info");
    } catch {
      showToast("Failed to update key.", "error");
    }
  };

  const revokeKey = (id: string) => {
    const k = keys.find(x => x.id === id);
    showConfirm("Revoke API Key", `Permanently revoke "${k?.label ?? id}"? Agents using it will lose access immediately.`, async () => {
      try {
        await apiFetch(userId, `/api/agent/keys/${id}`, { method: "DELETE" });
        setKeys(prev => prev.filter(x => x.id !== id));
        showToast("API key revoked.", "info");
      } catch {
        showToast("Failed to revoke key.", "error");
      }
    });
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      showToast("Secret copied to clipboard.", "success");
    } catch {
      showToast("Copy failed — select and copy manually.", "error");
    }
  };

  return (
    <div className="space-y-6 p-6 md:p-8 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Agent API Access</h2>
          <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">
            Issue API keys so other apps can retrieve chunks from your documents
          </p>
        </div>
        <button
          onClick={() => setIsNewKeyOpen(true)}
          className="ml-auto flex items-center gap-2 px-4 py-2.5 bg-[#86C9A4] text-black text-xs font-bold uppercase tracking-wider rounded-lg hover:brightness-110 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Create Key
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Calls", value: totals.calls, icon: Activity },
          { label: "This Month", value: totals.month, icon: CalendarClock },
          { label: "Active Keys", value: totals.active, icon: Zap },
        ].map(c => (
          <div key={c.label} className="bg-[#131720] border border-white/10 rounded-xl p-4">
            <c.icon className="w-4 h-4 text-[#86C9A4] mb-2" />
            <p className="font-display text-xl font-extrabold text-white">{c.value}</p>
            <p className="font-mono text-[9px] text-white/55 uppercase tracking-wider mt-1">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-white/10">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60">Your API Keys</h3>
        </div>
        {keys.length === 0 ? (
          <p className="text-center py-10 text-xs font-mono text-white/45">No keys yet. Create one to let apps query your knowledge base.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[720px]">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[9px] uppercase tracking-widest text-white/55">
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3 hidden md:table-cell">Scope</th>
                <th className="px-4 py-3 hidden lg:table-cell">Rate Limit</th>
                <th className="px-4 py-3 hidden lg:table-cell">Usage</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                  <td className="px-4 py-3">
                    <p className="text-xs font-bold text-white">{k.label}</p>
                    <p className="font-mono text-[9px] text-white/45">{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleString()}` : "Never used"}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-[#86C9A4]">{k.keyPreview}</td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {k.sourceFilter.length === 0
                      ? <span className="font-mono text-[9px] text-white/55 uppercase">All visible</span>
                      : <span className="font-mono text-[9px] text-white/55">{k.sourceFilter.length} source(s)</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-white/50 hidden lg:table-cell">{k.rateLimit === 0 ? "∞" : `${k.rateLimit}/min`}</td>
                  <td className="px-4 py-3 font-mono text-[10px] text-white/50 hidden lg:table-cell">{k.usageCount} ({k.usageThisMonth} mo)</td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleKey(k.id, !k.enabled)} className="cursor-pointer">
                      {k.enabled ? <ToggleRight className="w-5 h-5 text-[#86C9A4]" /> : <ToggleLeft className="w-5 h-5 text-white/45" />}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => revokeKey(k.id)}
                      className="p-1.5 rounded text-white/55 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                      title="Revoke this key"
                      aria-label="Revoke key"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Create Key modal */}
      {isNewKeyOpen && (
        <form onSubmit={createKey} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => setIsNewKeyOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-md mx-4 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-[#86C9A4]" /> Create API Key
            </h3>
            <input
              value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. LangChain Prod Bot" required
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
            />
            <label className="space-y-1.5 block">
              <span className="flex justify-between font-mono text-[10px] text-white/50 uppercase tracking-wider">
                <span>Rate Limit (req/min, 0 = unlimited)</span><span className="text-[#86C9A4] font-bold">{rateLimit}</span>
              </span>
              <input type="range" min={0} max={600} step={10} value={rateLimit} onChange={e => setRateLimit(Number(e.target.value))} className="w-full accent-[#86C9A4]" />
            </label>
            <div className="space-y-2">
              <p className="font-mono text-[10px] text-white/50 uppercase tracking-wider font-bold">Restrict to sources (empty = all visible)</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {visibleSources.length === 0 ? (
                  <p className="text-[10px] font-mono text-white/45">No visible sources yet.</p>
                ) : visibleSources.map(s => (
                  <label key={s.id} className="flex items-center gap-2.5 cursor-pointer hover:bg-white/5 rounded px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={sourceFilter.includes(s.id)}
                      onChange={() => toggleSource(s.id)}
                      className="accent-[#86C9A4]"
                    />
                    <span className="text-xs text-white/70 truncate flex-1">{s.name}</span>
                    {s.ownerId !== userId && <span className="font-mono text-[8px] text-[#86C9A4] uppercase">shared</span>}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={() => setIsNewKeyOpen(false)}
                className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer">Cancel</button>
              <button type="submit"
                className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 cursor-pointer uppercase tracking-widest">Create</button>
            </div>
          </div>
        </form>
      )}

      {/* One-time secret modal */}
      {secret !== null && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center" onClick={() => setSecret(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-[#86C9A4]/40 rounded-xl p-6 w-full max-w-lg mx-4 space-y-4 shadow-2xl">
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[#86C9A4]">Secret — copy it now</h3>
            <p className="text-[11px] text-white/50 font-mono leading-relaxed">
              This is the only time the full key is shown. It will never be retrievable again.
            </p>
            <div className="flex items-center gap-2 bg-[#0E1218] border border-white/10 rounded-lg p-3">
              <code className="flex-1 text-[11px] text-[#86C9A4] font-mono break-all">{secret}</code>
              <button
                onClick={copySecret}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                  copied
                    ? "border-[#86C9A4]/40 text-[#86C9A4] bg-[#86C9A4]/10"
                    : "border-white/10 text-white/50 hover:text-[#86C9A4] hover:border-[#86C9A4]/40"
                }`}
                title="Copy"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setSecret(null)} className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 cursor-pointer uppercase tracking-widest">
                I've copied it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Reference */}
      <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
        <div className="flex items-center border-b border-white/10">
          <BookOpen className="w-4 h-4 text-[#86C9A4] ml-4 mr-2" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60 py-3">API Reference</span>
          <span className="ml-auto pr-4 font-mono text-[9px] uppercase tracking-wider text-[#86C9A4]/70">POST /agent/retrieve</span>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider font-bold mb-2 flex items-center gap-1.5">
              <Code2 className="w-3.5 h-3.5 text-[#86C9A4]" /> Request
            </p>
            <pre className="bg-[#0E1218] border border-white/10 rounded-lg p-4 text-[11px] font-mono text-[#86C9A4] overflow-x-auto">
{`POST /api/agent/retrieve
X-API-Key: mrmk_...
{
  "query": "2024年国巨集团的毛利率是多少？",
  "topK": 5,
  "minScore": 0.3,
  "sourceFilter": []            // optional
}`}
            </pre>
          </div>
          <div>
            <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider font-bold mb-2">Response</p>
            <pre className="bg-[#0E1218] border border-white/10 rounded-lg p-4 text-[11px] font-mono text-white/70 overflow-x-auto">
{`{
  "query": "...",
  "chunks": [
    {
      "chunkId": "src-...-chk-0",
      "sourceId": "src-...",
      "sourceName": "YAGEO_ESG2024_tw",
      "text": "...",
      "score": 0.82,
      "tokenCount": 128
    }
  ],
  "context": "[Document 1: YAGEO_ESG2024_tw]\\n...",
  "latencyMs": 245
}`}
            </pre>
          </div>
          <p className="text-[11px] text-white/55 leading-relaxed">
            The key can only retrieve chunks from <span className="text-white/70">the owner's documents plus platform-shared documents</span>.
            <code className="font-mono text-[#86C9A4]">context</code> is pre-assembled for direct use in an external LLM prompt.
          </p>
        </div>
      </div>
    </div>
  );
}
