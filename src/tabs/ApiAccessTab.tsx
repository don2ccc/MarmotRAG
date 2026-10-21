import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Key, Plus, Copy, Check, Trash2, Zap, CalendarClock, Activity, ToggleLeft, ToggleRight,
  Code2, BookOpen, Pencil, ShieldCheck, Folder,
} from "lucide-react";
import { apiFetch } from "../api";
import { EMPTY_SCOPE, type AgentApiKeyCreated, type AgentApiKeyPublic, type Collection, type KeyScope, type SourceDoc } from "../types";

interface Props {
  userId: string;
  sources: SourceDoc[];
  showToast: (message: string, type?: "success" | "info" | "error") => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

const KINDS = ["policy", "process", "contract", "template", "annex", "memory", "document"];

function matchesScope(scope: KeyScope, doc: SourceDoc): boolean {
  if (scope.all) return true;
  const okCollection = scope.collections.length === 0 || (!!doc.collectionId && scope.collections.includes(doc.collectionId));
  const okKind = scope.kinds.length === 0 || scope.kinds.includes(doc.kind ?? "document");
  const okTag = scope.tags.length === 0 || (doc.tags ?? []).some(t => scope.tags.includes(t));
  const okDoc = scope.docIds.length === 0 || scope.docIds.includes(doc.id);
  return okCollection && okKind && okTag && okDoc;
}

function scopeIsEmpty(scope: KeyScope): boolean {
  return !scope.all
    && scope.collections.length === 0
    && scope.kinds.length === 0
    && scope.tags.length === 0
    && scope.docIds.length === 0;
}

function scopeSummary(scope: KeyScope, collections: Collection[]): string {
  if (scope.all) return "全部文档";
  if (scopeIsEmpty(scope)) return "无权限（拒绝）";
  const parts: string[] = [];
  if (scope.collections.length) {
    parts.push(scope.collections.map(id => collections.find(c => c.id === id)?.name ?? id).join(" / "));
  }
  if (scope.kinds.length) parts.push(scope.kinds.join(" / "));
  if (scope.tags.length) parts.push(`#${scope.tags.join(" #")}`);
  if (scope.docIds.length) parts.push(`${scope.docIds.length} 篇指定文档`);
  return parts.join(" · ");
}

export default function ApiAccessTab({ userId, sources, showToast, showConfirm }: Props) {
  const [keys, setKeys] = useState<AgentApiKeyPublic[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [scope, setScope] = useState<KeyScope>({ ...EMPTY_SCOPE });
  const [tagInput, setTagInput] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    apiFetch(userId, "/api/agent/keys").then(r => r.json()).then(setKeys).catch(() => {});
    apiFetch(userId, "/api/collections").then(r => r.json())
      .then((d: { collections: Collection[] }) => setCollections(d.collections ?? [])).catch(() => {});
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  const totals = useMemo(() => ({
    calls: keys.reduce((s, k) => s + k.usageCount, 0),
    month: keys.reduce((s, k) => s + k.usageThisMonth, 0),
    active: keys.filter(k => k.enabled).length,
  }), [keys]);

  const reachable = useMemo(() => {
    const docs = sources.filter(s => matchesScope(scope, s));
    return {
      total: docs.length,
      indexed: docs.filter(s => typeof s.versionNo === "number").length,
      expired: docs.filter(s => s.effectiveTo && new Date(s.effectiveTo).getTime() < Date.now()).length,
      drafts: docs.filter(s => s.lifecycle === "draft").length,
    };
  }, [scope, sources]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of sources) for (const t of s.tags ?? []) set.add(t);
    return [...set].sort();
  }, [sources]);

  const resetForm = () => {
    setEditingId(null);
    setLabel("");
    setRateLimit(60);
    setScope({ ...EMPTY_SCOPE });
    setTagInput("");
  };

  const openCreate = () => { resetForm(); setIsOpen(true); };

  const openEdit = (key: AgentApiKeyPublic) => {
    setEditingId(key.id);
    setLabel(key.label);
    setRateLimit(key.rateLimit);
    setScope({ ...key.scope });
    setTagInput("");
    setIsOpen(true);
  };

  const toggleIn = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];

  const addTag = () => {
    const tag = tagInput.trim().replace(/^#/, "");
    if (!tag) return;
    setScope(s => ({ ...s, tags: s.tags.includes(tag) ? s.tags : [...s.tags, tag] }));
    setTagInput("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    try {
      const body = { label, rateLimit, scope };
      const res = editingId
        ? await apiFetch(userId, `/api/agent/keys/${editingId}`, { method: "PATCH", body: JSON.stringify(body) })
        : await apiFetch(userId, "/api/agent/keys", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to save key");

      if (!editingId) {
        setSecret(data.key);
        const { key: _s, ...pub } = data as AgentApiKeyCreated;
        setKeys(prev => [...prev, pub]);
        showToast("API key created. Copy the secret now — it won't be shown again.", "success");
      } else {
        setKeys(prev => prev.map(k => k.id === editingId ? { ...k, ...data } : k));
        showToast("访问范围已更新，立即生效。", "success");
      }
      setIsOpen(false);
      resetForm();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save API key.", "error");
    }
  };

  const toggleKey = async (id: string, enabled: boolean) => {
    try {
      const res = await apiFetch(userId, `/api/agent/keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      if (!res.ok) throw new Error();
      setKeys(prev => prev.map(k => k.id === id ? { ...k, enabled } : k));
      showToast(enabled ? "API key enabled." : "API key disabled.", "info");
    } catch {
      showToast("Failed to update key.", "error");
    }
  };

  const revokeKey = (id: string) => {
    const k = keys.find(x => x.id === id);
    showConfirm("Revoke API Key", `Permanently revoke "${k?.label ?? id}"? Agents using it lose access immediately.`, async () => {
      await apiFetch(userId, `/api/agent/keys/${id}`, { method: "DELETE" }).catch(() => {});
      setKeys(prev => prev.filter(x => x.id !== id));
      showToast("API key revoked.", "info");
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
    <div className="space-y-6 p-6 md:p-8 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Agent API Access</h2>
          <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">
            Keys carry a declarative scope · evaluated at query time
          </p>
        </div>
        <button onClick={openCreate} className="ml-auto flex items-center gap-2 px-4 py-2.5 bg-[#86C9A4] text-black text-xs font-bold uppercase tracking-wider rounded-lg hover:brightness-110 cursor-pointer">
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
        <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#86C9A4]" />
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/60">API Keys</h3>
        </div>
        {keys.length === 0 ? (
          <p className="text-center py-10 text-xs font-mono text-white/45">No keys yet. Create one to let agents query the knowledge base.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[760px]">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[9px] uppercase tracking-widest text-white/55">
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Access scope</th>
                  <th className="px-4 py-3 hidden lg:table-cell">Rate</th>
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
                      <p className="font-mono text-[9px] text-white/45">
                        {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleString()}` : "Never used"}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-[#86C9A4]">{k.keyPreview}</td>
                    <td className="px-4 py-3">
                      <p className={`font-mono text-[9px] ${scopeIsEmpty(k.scope) ? "text-red-300" : "text-white/65"}`}>
                        {scopeSummary(k.scope, collections)}
                      </p>
                      <p className="font-mono text-[8px] text-white/35 mt-0.5">
                        {k.scope.allowAsOf ? "含历史版本" : "仅当前版本"}
                        {k.scope.allowDraft ? " · 含草稿" : ""}
                        {k.scope.allowExpired ? " · 含过期" : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-white/50 hidden lg:table-cell">{k.rateLimit === 0 ? "∞" : `${k.rateLimit}/min`}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-white/50 hidden lg:table-cell">{k.usageCount} ({k.usageThisMonth} mo)</td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggleKey(k.id, !k.enabled)} className="cursor-pointer">
                        {k.enabled ? <ToggleRight className="w-5 h-5 text-[#86C9A4]" /> : <ToggleLeft className="w-5 h-5 text-white/45" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(k)} className="p-1.5 rounded text-white/55 hover:text-[#86C9A4] hover:bg-[#86C9A4]/10 cursor-pointer" title="编辑访问范围">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => revokeKey(k.id)} className="p-1.5 rounded text-white/55 hover:text-red-400 hover:bg-red-500/10 cursor-pointer" title="Revoke">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / edit key */}
      {isOpen && (
        <form onSubmit={submit} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => setIsOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-2xl mx-4 space-y-5 shadow-2xl max-h-[88vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-[#86C9A4]" /> {editingId ? "编辑访问范围" : "新建 API Key"}
              </h3>
              <button type="button" onClick={() => setIsOpen(false)} className="text-white/50 hover:text-white cursor-pointer text-xs font-mono">ESC</button>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <label className="space-y-1 block">
                <span className="font-mono text-[9px] uppercase tracking-widest text-white/45">名称</span>
                <input
                  value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. HR Assistant" required
                  className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
                />
              </label>
              <label className="space-y-1 block">
                <span className="flex justify-between font-mono text-[9px] uppercase tracking-widest text-white/45">
                  <span>速率限制 (req/min，0 = 不限)</span><span className="text-[#86C9A4]">{rateLimit}</span>
                </span>
                <input type="range" min={0} max={600} step={10} value={rateLimit} onChange={e => setRateLimit(Number(e.target.value))} className="w-full accent-[#86C9A4]" />
              </label>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#0E1218] p-4 space-y-4">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scope.all}
                  onChange={e => setScope(s => ({ ...s, all: e.target.checked }))}
                  className="accent-[#86C9A4]"
                />
                <span className="text-xs text-white/85 font-bold">全部文档（不受集合/类型限制）</span>
                <span className="ml-auto font-mono text-[8px] uppercase text-yellow-300/80">谨慎使用</span>
              </label>

              <div className={`space-y-4 ${scope.all ? "opacity-40 pointer-events-none" : ""}`}>
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-widest text-white/45 mb-1.5 flex items-center gap-1.5">
                    <Folder className="w-3 h-3" /> 集合（空 = 不限）
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {collections.map(c => {
                      const on = scope.collections.includes(c.id);
                      return (
                        <button
                          key={c.id} type="button"
                          onClick={() => setScope(s => ({ ...s, collections: toggleIn(s.collections, c.id) }))}
                          className={`px-2 py-1 rounded border text-[10px] font-mono cursor-pointer ${
                            on ? "border-[#86C9A4]/50 bg-[#86C9A4]/15 text-[#86C9A4]" : "border-white/10 text-white/55 hover:border-white/25"
                          }`}
                        >
                          {c.name} <span className="opacity-50">{c.documentCount}</span>
                        </button>
                      );
                    })}
                    {collections.length === 0 && <span className="font-mono text-[9px] text-white/35">还没有集合</span>}
                  </div>
                </div>

                <div>
                  <p className="font-mono text-[9px] uppercase tracking-widest text-white/45 mb-1.5">文档类型（空 = 不限）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {KINDS.map(k => {
                      const on = scope.kinds.includes(k);
                      return (
                        <button
                          key={k} type="button"
                          onClick={() => setScope(s => ({ ...s, kinds: toggleIn(s.kinds, k) }))}
                          className={`px-2 py-1 rounded border text-[10px] font-mono cursor-pointer ${
                            on ? "border-[#86C9A4]/50 bg-[#86C9A4]/15 text-[#86C9A4]" : "border-white/10 text-white/55 hover:border-white/25"
                          }`}
                        >
                          {k}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="font-mono text-[9px] uppercase tracking-widest text-white/45 mb-1.5">标签（空 = 不限）</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {scope.tags.map(tag => (
                      <button
                        key={tag} type="button"
                        onClick={() => setScope(s => ({ ...s, tags: s.tags.filter(t => t !== tag) }))}
                        className="px-2 py-1 rounded border border-[#86C9A4]/40 bg-[#86C9A4]/10 text-[#86C9A4] text-[10px] font-mono cursor-pointer"
                      >
                        #{tag} ×
                      </button>
                    ))}
                    <input
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                      placeholder="输入后回车添加"
                      list="known-tags"
                      className="px-2 py-1 bg-transparent border border-white/10 rounded text-[10px] text-white placeholder-white/30 focus:outline-none w-36"
                    />
                    <datalist id="known-tags">
                      {availableTags.map(t => <option key={t} value={t} />)}
                    </datalist>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 pt-1">
                  {[
                    { key: "allowDraft" as const, label: "包含草稿版本" },
                    { key: "allowExpired" as const, label: "包含已过期文档" },
                    { key: "allowAsOf" as const, label: "允许 asOf 查历史" },
                  ].map(({ key, label: text }) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={scope[key]}
                        onChange={e => setScope(s => ({ ...s, [key]: e.target.checked }))}
                        className="accent-[#86C9A4]"
                      />
                      <span className="text-[10px] text-white/70">{text}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="border-t border-white/10 pt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <p className="font-mono text-[10px] text-white/70">
                  可访问 <span className="text-[#86C9A4] font-bold">{reachable.total}</span> 篇
                </p>
                <p className="font-mono text-[9px] text-white/40">其中已索引 {reachable.indexed}</p>
                {reachable.drafts > 0 && <p className="font-mono text-[9px] text-white/40">草稿 {reachable.drafts}</p>}
                {reachable.expired > 0 && <p className="font-mono text-[9px] text-yellow-300/70">已过期 {reachable.expired}</p>}
                {scopeIsEmpty(scope) && (
                  <p className="font-mono text-[9px] text-red-300/90 w-full">空范围 = 拒绝：这个 key 将查不到任何内容。</p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setIsOpen(false)} className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer">取消</button>
              <button type="submit" className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 cursor-pointer uppercase tracking-widest">
                {editingId ? "保存范围" : "创建"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* One-time secret */}
      {secret !== null && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center" onClick={() => setSecret(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-[#86C9A4]/40 rounded-xl p-6 w-full max-w-lg mx-4 space-y-4 shadow-2xl">
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-[#86C9A4]">Secret — copy it now</h3>
            <p className="text-[11px] text-white/50 font-mono leading-relaxed">This is the only time the full key is shown. It will never be retrievable again.</p>
            <div className="flex items-center gap-2 bg-[#0E1218] border border-white/10 rounded-lg p-3">
              <code className="flex-1 text-[11px] text-[#86C9A4] font-mono break-all">{secret}</code>
              <button onClick={copySecret} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider cursor-pointer ${
                copied ? "border-[#86C9A4]/40 text-[#86C9A4] bg-[#86C9A4]/10" : "border-white/10 text-white/50 hover:text-[#86C9A4]"
              }`}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setSecret(null)} className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded cursor-pointer uppercase tracking-widest">I've copied it</button>
            </div>
          </div>
        </div>
      )}

      {/* API reference */}
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
  "query": "新员工年假多少天？",
  "topK": 5,
  "minScore": 0.3,
  "collections": ["col-hr"],     // optional, 只能收窄 key 的范围
  "kinds": ["policy"],           // optional
  "asOf": "2025-06-01"           // optional, 需要 key 允许
}`}
            </pre>
          </div>
          <div>
            <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider font-bold mb-2">Response</p>
            <pre className="bg-[#0E1218] border border-white/10 rounded-lg p-4 text-[11px] font-mono text-white/70 overflow-x-auto">
{`{
  "retrievalId": "rtv-...",
  "status": "hit | weak | empty",
  "chunks": [
    {
      "chunkId": "src-...-chk-0",
      "sourceId": "src-...",
      "clauseNo": "第十二条",
      "text": "...",
      "score": 0.82
    }
  ],
  "citations": [ { "citationId": "c1", "docId": "...", "versionNo": 3 } ],
  "context": "[c1] 第十二条 ...",
  "diagnostics": { "vectorHits": 18, "lexicalHits": 0, "bestScore": 0.82 }
}`}
            </pre>
          </div>
          <p className="text-[11px] text-white/55 leading-relaxed">
            可见范围由 key 的 <span className="text-white/75">scope</span> 决定，请求参数只能在此基础上收窄。
            <code className="font-mono text-[#86C9A4]"> empty scope</code> 表示拒绝一切访问。
          </p>
        </div>
      </div>
    </div>
  );
}
