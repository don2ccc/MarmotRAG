import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import {
  Plus, Search, Upload, FileText, RefreshCw, Trash2, Layers, X, Check,
  AlertTriangle, FolderPlus, Folder, CalendarClock, ChevronRight, FolderInput,
  CalendarRange, Inbox, CircleAlert, ArrowRight,
} from "lucide-react";
import { apiFetch } from "../api";
import type { Collection, IndexingProgress, SourceDoc } from "../types";

interface Props {
  userId: string;
  sources: SourceDoc[];
  setSources: Dispatch<SetStateAction<SourceDoc[]>>;
  indexingProgress: Record<string, IndexingProgress>;
  setIndexingProgress: Dispatch<SetStateAction<Record<string, IndexingProgress>>>;
  showToast: (message: string, type?: "success" | "info" | "error") => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

type View = { type: "all" } | { type: "smart"; id: string } | { type: "collection"; id: string };

const KINDS = ["policy", "process", "contract", "template", "annex", "memory", "document"];
const LIFECYCLES = ["effective", "draft", "expired", "revoked"];

const SMART_VIEWS: { id: string; label: string; icon: typeof Inbox; test: (s: SourceDoc) => boolean }[] = [
  {
    id: "needs-rebuild",
    label: "待重建",
    icon: RefreshCw,
    test: s => !s.versionNo || s.vectorsCount === 0 || s.status === "Paused",
  },
  {
    id: "failed",
    label: "构建失败",
    icon: CircleAlert,
    test: s => !!s.lastError,
  },
  {
    id: "expiring",
    label: "30 天内过期",
    icon: CalendarClock,
    test: s => {
      if (!s.effectiveTo) return false;
      const days = (new Date(s.effectiveTo).getTime() - Date.now()) / 86_400_000;
      return days >= 0 && days <= 30;
    },
  },
  {
    id: "expired",
    label: "已过期",
    icon: AlertTriangle,
    test: s => !!s.effectiveTo && new Date(s.effectiveTo).getTime() < Date.now(),
  },
  {
    id: "unfiled",
    label: "未归档",
    icon: Inbox,
    test: s => !s.collectionId,
  },
];

/** Subscribe to a /api/sources SSE stream, updating sources list in real-time. */
function subscribeToIndexSSE(
  userId: string,
  url: string,
  body: object,
  setSources: Props["setSources"],
  setIndexingProgress: Props["setIndexingProgress"],
): Promise<string> {
  return new Promise((resolve, reject) => {
    apiFetch(userId, url, { method: "POST", body: JSON.stringify(body) }).then(async (res) => {
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        reject(new Error(errBody.error || `Request failed (${res.status})`));
        return;
      }
      if (!res.body) { reject(new Error("SSE request failed")); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let docId = "";

      const processChunk = (text: string) => {
        buffer += text;
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const msg of messages) {
          if (!msg.trim()) continue;
          const eventMatch = msg.match(/^event: (\w+)/m);
          const dataMatch = msg.match(/^data: (.+)/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (event === "start") {
            docId = data.doc.id;
            setSources(prev => {
              if (prev.find(s => s.id === docId)) return prev.map(s => s.id === docId ? { ...s, ...data.doc } : s);
              return [data.doc, ...prev];
            });
            setIndexingProgress(p => ({ ...p, [docId]: { done: 0, total: data.total } }));
          } else if (event === "progress") {
            setIndexingProgress(p => ({ ...p, [docId]: { done: data.done, total: data.total } }));
          } else if (event === "done") {
            setSources(prev => prev.map(s => s.id === docId ? { ...s, ...data.doc } : s));
            setIndexingProgress(p => { const n = { ...p }; delete n[docId]; return n; });
            resolve(docId);
          } else if (event === "error") {
            const nextStatus = data.status === "Synced" ? "Synced" : "Auth Error";
            setSources(prev => prev.map(s => s.id === docId ? { ...s, status: nextStatus, lastError: data.message } : s));
            setIndexingProgress(p => { const n = { ...p }; delete n[docId]; return n; });
            reject(new Error(data.message));
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processChunk(decoder.decode(value, { stream: true }));
      }
    }).catch(reject);
  });
}

function statusTone(status: string, hasError: boolean): string {
  if (hasError) return "bg-red-500/15 text-red-300";
  if (status === "Synced") return "bg-[#86C9A4]/15 text-[#86C9A4]";
  if (status === "Syncing...") return "bg-blue-500/15 text-blue-300";
  if (status === "Paused") return "bg-yellow-500/15 text-yellow-300";
  return "bg-white/10 text-white/55";
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

export default function KnowledgeBaseTab(props: Props) {
  const { userId, sources, setSources, indexingProgress, setIndexingProgress, showToast, showConfirm } = props;

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [view, setView] = useState<View>({ type: "all" });
  const [collections, setCollections] = useState<Collection[]>([]);
  const [newCollection, setNewCollection] = useState("");
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [isNewDocOpen, setIsNewDocOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [newDocType, setNewDocType] = useState("Text Document");
  const [newDocContent, setNewDocContent] = useState("");
  const [uploadCollectionId, setUploadCollectionId] = useState("");
  const [isFileParsing, setIsFileParsing] = useState(false);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<"overview" | "versions" | "chunks">("overview");
  const [versions, setVersions] = useState<Record<string, unknown>[]>([]);
  const [chunks, setChunks] = useState<{ id: string; text: string; tokensCount: number; clauseNo?: string | null }[]>([]);
  const [isDrawerLoading, setIsDrawerLoading] = useState(false);

  const [validityOpen, setValidityOpen] = useState(false);
  const [validityFrom, setValidityFrom] = useState("");
  const [validityTo, setValidityTo] = useState("");
  const [validityLifecycle, setValidityLifecycle] = useState("effective");

  const loadCollections = async () => {
    try {
      const res = await apiFetch(userId, "/api/collections");
      if (!res.ok) return;
      const data = await res.json() as { collections: Collection[] };
      setCollections(data.collections ?? []);
    } catch { /* offline */ }
  };

  useEffect(() => { void loadCollections(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const refreshSources = async () => {
    try {
      const res = await apiFetch(userId, "/api/sources");
      if (!res.ok) return;
      const data = await res.json() as { sources: SourceDoc[] };
      setSources(data.sources ?? []);
    } catch { /* offline */ }
  };

  const filtered = useMemo(() => {
    let list = sources;
    if (view.type === "collection") list = list.filter(s => s.collectionId === view.id);
    if (view.type === "smart") {
      const def = SMART_VIEWS.find(v => v.id === view.id);
      if (def) list = list.filter(def.test);
    }
    if (kindFilter) list = list.filter(s => (s.kind ?? "document") === kindFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(s =>
        s.name.toLowerCase().includes(q)
        || (s.docNo ?? "").toLowerCase().includes(q)
        || (s.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [sources, view, kindFilter, search]);

  const groups = useMemo(() => {
    if (view.type !== "all") return [{ id: "single", name: "", docs: filtered }];
    const map = new Map<string, SourceDoc[]>();
    for (const doc of filtered) {
      const key = doc.collectionId ?? "__none__";
      const bucket = map.get(key) ?? [];
      bucket.push(doc);
      map.set(key, bucket);
    }
    const nameOf = (id: string): string =>
      id === "__none__" ? "未归档" : collections.find(c => c.id === id)?.name ?? "未知集合";
    return [...map.entries()]
      .map(([id, docs]) => ({ id, name: nameOf(id), docs }))
      .sort((a, b) => (a.id === "__none__" ? 1 : b.id === "__none__" ? -1 : a.name.localeCompare(b.name)));
  }, [filtered, view, collections]);

  const toggleSelected = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected(new Set(filtered.map(s => s.id)));
  };

  const patchDocs = async (ids: string[], body: Record<string, unknown>): Promise<number> => {
    let ok = 0;
    for (const id of ids) {
      try {
        const res = await apiFetch(userId, `/api/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        if (res.ok) ok++;
      } catch { /* keep going */ }
    }
    if (ok > 0) await refreshSources();
    return ok;
  };

  const reindexOne = async (docId: string): Promise<void> => {
    setSources(prev => prev.map(s => s.id === docId ? { ...s, status: "Syncing...", lastError: null } : s));
    await subscribeToIndexSSE(userId, `/api/sources/${docId}/reindex`, {}, setSources, setIndexingProgress);
    await refreshSources();
  };

  const handleFileUpload = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) { showToast("File exceeds the 50 MB limit.", "error"); return; }
    setIsFileParsing(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const res = await apiFetch(userId, "/api/parse-document", {
        method: "POST", body: JSON.stringify({ base64, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "parse failed");
      setNewDocContent(data.text);
      setNewDocType(data.format === "pdf" ? "PDF Collection" : "Text Document");
      if (!newDocName.trim()) setNewDocName(file.name.replace(/\.[^.]+$/, ""));
      showToast(data.format === "pdf" ? `PDF parsed — ${data.pages} page(s).` : "Text extracted.", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to parse the document.", "error");
    } finally {
      setIsFileParsing(false);
    }
  };

  const addDocument = async (e: FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim() || !newDocContent.trim()) {
      showToast("Please fill in document name and text content.", "error");
      return;
    }
    setIsEmbedding(true);
    setIsNewDocOpen(false);
    try {
      const docId = await subscribeToIndexSSE(userId, "/api/sources", {
        name: newDocName, content: newDocContent, type: newDocType,
      }, setSources, setIndexingProgress);
      if (uploadCollectionId && docId) {
        await apiFetch(userId, `/api/sources/${docId}`, {
          method: "PATCH", body: JSON.stringify({ collectionId: uploadCollectionId }),
        });
        await refreshSources();
      }
      showToast("Document indexed successfully.", "success");
      setNewDocName(""); setNewDocContent(""); setUploadCollectionId("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Embedding failed.", "error");
    } finally {
      setIsEmbedding(false);
    }
  };

  const createCollection = async () => {
    const name = newCollection.trim();
    if (!name) return;
    try {
      const res = await apiFetch(userId, "/api/collections", {
        method: "POST", body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setNewCollection("");
      setIsCreatingCollection(false);
      await loadCollections();
      showToast("Collection created.", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create the collection.", "error");
    }
  };

  const removeCollection = (collection: Collection) => {
    showConfirm(
      "删除集合",
      `删除「${collection.name}」？其中的 ${collection.documentCount} 篇文档会被移出集合，但不会被删除。`,
      async () => {
        const res = await apiFetch(userId, `/api/collections/${collection.id}`, { method: "DELETE" });
        if (!res.ok) { showToast("删除集合失败。", "error"); return; }
        await loadCollections();
        await refreshSources();
        if (view.type === "collection" && view.id === collection.id) setView({ type: "all" });
        showToast("集合已删除，文档保留。", "info");
      }
    );
  };

  const openDrawer = async (doc: SourceDoc) => {
    setDrawerId(doc.id);
    setDrawerTab("overview");
    setVersions([]);
    setChunks([]);
    setIsDrawerLoading(true);
    try {
      const [v, c] = await Promise.all([
        apiFetch(userId, `/api/sources/${doc.id}/versions`).then(r => r.ok ? r.json() : { versions: [] }),
        apiFetch(userId, `/api/sources/${doc.id}/chunks?limit=8`).then(r => r.ok ? r.json() : { chunks: [] }),
      ]);
      setVersions(v.versions ?? []);
      setChunks(c.chunks ?? []);
    } catch { /* ignore */ } finally {
      setIsDrawerLoading(false);
    }
  };

  const deleteDocs = (ids: string[]) => {
    const label = ids.length === 1 ? sources.find(s => s.id === ids[0])?.name ?? ids[0] : `${ids.length} 篇文档`;
    showConfirm("删除文档", `删除「${label}」？所有版本与向量都会移除。`, async () => {
      for (const id of ids) {
        await apiFetch(userId, `/api/sources/${id}`, { method: "DELETE" }).catch(() => {});
      }
      setSelected(new Set());
      await refreshSources();
      if (drawerId && ids.includes(drawerId)) setDrawerId(null);
      showToast("已删除。", "info");
    });
  };

  const applyValidity = async () => {
    const ids = [...selected];
    const body: Record<string, unknown> = { lifecycle: validityLifecycle };
    if (validityFrom) body.effectiveFrom = new Date(validityFrom).toISOString();
    if (validityTo) body.effectiveTo = new Date(validityTo).toISOString();
    const ok = await patchDocs(ids, body);
    setValidityOpen(false);
    showToast(`已更新 ${ok} 篇文档的有效期。`, ok > 0 ? "success" : "error");
  };

  const bulkReindex = async () => {
    const ids = [...selected].filter(id => !indexingProgress[id]);
    for (const id of ids) {
      try { await reindexOne(id); } catch { /* continue with the rest */ }
    }
    await refreshSources();
    showToast(`重建完成：${ids.length} 篇。`, "success");
  };

  const drawerDoc = drawerId ? sources.find(s => s.id === drawerId) : null;
  const activeSmart = view.type === "smart" ? SMART_VIEWS.find(v => v.id === view.id) : null;

  return (
    <div className="flex h-[calc(100vh-4rem)] md:h-screen min-h-0">
      {/* ── Left rail ─────────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 border-r border-white/10 p-4 space-y-5 overflow-y-auto">
        <div>
          <button
            onClick={() => { setView({ type: "all" }); setSelected(new Set()); }}
            className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[11px] font-bold cursor-pointer ${
              view.type === "all" ? "bg-[#86C9A4]/15 text-[#86C9A4]" : "text-white/70 hover:bg-white/5"
            }`}
          >
            <span className="flex items-center gap-2"><Layers className="w-3.5 h-3.5" /> 全部文档</span>
            <span className="font-mono text-[9px]">{sources.length}</span>
          </button>
        </div>

        <div>
          <p className="font-mono text-[8px] uppercase tracking-widest text-white/35 px-2.5 mb-1.5">智能视图</p>
          <div className="space-y-0.5">
            {SMART_VIEWS.map(def => {
              const count = sources.filter(def.test).length;
              const active = view.type === "smart" && view.id === def.id;
              const Icon = def.icon;
              return (
                <button
                  key={def.id}
                  onClick={() => { setView({ type: "smart", id: def.id }); setSelected(new Set()); }}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[10px] cursor-pointer ${
                    active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5"
                  }`}
                >
                  <span className="flex items-center gap-2"><Icon className={`w-3 h-3 ${count > 0 && def.id !== "unfiled" ? "text-yellow-300/80" : "opacity-60"}`} /> {def.label}</span>
                  <span className={`font-mono text-[9px] ${count > 0 ? "text-white/70" : "text-white/30"}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between px-2.5 mb-1.5">
            <p className="font-mono text-[8px] uppercase tracking-widest text-white/35">集合</p>
            <button onClick={() => setIsCreatingCollection(v => !v)} className="text-white/45 hover:text-[#86C9A4] cursor-pointer" title="新建集合">
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {isCreatingCollection && (
            <div className="px-1.5 mb-2 flex items-center gap-1">
              <input
                autoFocus value={newCollection} onChange={e => setNewCollection(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void createCollection(); if (e.key === "Escape") setIsCreatingCollection(false); }}
                placeholder="集合名称"
                className="flex-1 min-w-0 px-2 py-1 bg-[#0E1218] border border-white/10 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
              />
              <button onClick={() => void createCollection()} className="text-[#86C9A4] cursor-pointer"><Check className="w-3.5 h-3.5" /></button>
            </div>
          )}

          <div className="space-y-0.5">
            {collections.map(c => {
              const active = view.type === "collection" && view.id === c.id;
              return (
                <div key={c.id} className="group flex items-center">
                  <button
                    onClick={() => { setView({ type: "collection", id: c.id }); setSelected(new Set()); }}
                    className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-1.5 rounded text-[10px] cursor-pointer ${
                      active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Folder className="w-3 h-3 opacity-60 shrink-0" />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <span className="font-mono text-[9px] text-white/40">{c.documentCount}</span>
                  </button>
                  <button
                    onClick={() => removeCollection(c)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-white/30 hover:text-red-400 cursor-pointer"
                    title="删除集合"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
            {collections.length === 0 && (
              <p className="px-2.5 text-[9px] font-mono text-white/30 leading-relaxed">还没有集合。点右上角 + 创建。</p>
            )}
          </div>
        </div>

        <div className="pt-3 border-t border-white/5">
          <button
            onClick={() => setIsNewDocOpen(true)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-[#86C9A4] text-black text-[10px] font-bold uppercase tracking-wider rounded-lg hover:brightness-110 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> 添加文档
          </button>
        </div>
      </aside>

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-white truncate">
              {view.type === "all" ? "全部文档" : view.type === "collection" ? collections.find(c => c.id === view.id)?.name ?? "集合" : activeSmart?.label ?? "视图"}
            </h2>
            <p className="font-mono text-[9px] text-white/45 uppercase tracking-wider mt-0.5">
              {filtered.length} 篇 · 管理员维护
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/45" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="名称 / 文号 / 标签"
                className="pl-8 pr-3 py-2 bg-[#0E1218] border border-white/10 rounded-lg text-[11px] text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] w-52"
              />
            </div>
            <select
              value={kindFilter} onChange={e => setKindFilter(e.target.value)}
              className="px-2.5 py-2 bg-[#0E1218] border border-white/10 rounded-lg text-[10px] text-white/75 cursor-pointer focus:outline-none"
            >
              <option value="">全部类型</option>
              {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {filtered.length === 0 ? (
            <div className="py-20 text-center space-y-2">
              <p className="font-mono text-[11px] text-white/40">这个视图里没有文档。</p>
              <button onClick={() => setIsNewDocOpen(true)} className="font-mono text-[10px] text-[#86C9A4] hover:underline cursor-pointer">
                添加第一篇 →
              </button>
            </div>
          ) : (
            groups.map(group => (
              <div key={group.id}>
                {view.type === "all" && (
                  <div className="flex items-center gap-2 mb-2">
                    <Folder className="w-3.5 h-3.5 text-white/35" />
                    <span className="font-mono text-[9px] uppercase tracking-widest text-white/55">{group.name}</span>
                    <span className="font-mono text-[9px] text-white/30">{group.docs.length}</span>
                    <div className="flex-1 h-px bg-white/5" />
                  </div>
                )}

                <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-white/10 font-mono text-[8px] uppercase tracking-widest text-white/45">
                        <th className="px-3 py-2.5 w-8">
                          <button onClick={selectAllFiltered} className="text-white/40 hover:text-[#86C9A4] cursor-pointer" title="全选当前筛选">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </th>
                        <th className="px-3 py-2.5">文档</th>
                        <th className="px-3 py-2.5 w-20">状态</th>
                        <th className="px-3 py-2.5 w-24">生效期</th>
                        <th className="px-3 py-2.5 w-16 text-right">分块</th>
                        <th className="px-3 py-2.5 w-24 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.docs.map(doc => {
                        const progress = indexingProgress[doc.id];
                        const isSelected = selected.has(doc.id);
                        const expired = !!doc.effectiveTo && new Date(doc.effectiveTo).getTime() < Date.now();
                        return (
                          <tr
                            key={doc.id}
                            className={`border-b border-white/5 last:border-0 cursor-pointer ${isSelected ? "bg-[#86C9A4]/5" : "hover:bg-white/5"}`}
                            onClick={() => toggleSelected(doc.id)}
                          >
                            <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => toggleSelected(doc.id)}
                                className={`w-4 h-4 rounded border flex items-center justify-center cursor-pointer ${
                                  isSelected ? "bg-[#86C9A4] border-[#86C9A4] text-black" : "border-white/20 text-transparent"
                                }`}
                              >
                                <Check className="w-3 h-3" />
                              </button>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="w-3.5 h-3.5 text-[#86C9A4] shrink-0" />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <p className="text-[11px] font-bold text-white truncate max-w-[280px]">{doc.name}</p>
                                    {typeof doc.versionNo === "number" && (
                                      <span className="font-mono text-[8px] text-[#86C9A4]/80 border border-[#86C9A4]/20 rounded px-1 shrink-0">v{doc.versionNo}</span>
                                    )}
                                    {doc.kind && <span className="font-mono text-[8px] uppercase text-white/30 shrink-0">{doc.kind}</span>}
                                    {expired && <span className="font-mono text-[8px] uppercase text-yellow-300/90 border border-yellow-300/30 rounded px-1 shrink-0">expired</span>}
                                  </div>
                                  {doc.lastError && (
                                    <p className="font-mono text-[8px] text-red-300/70 truncate max-w-[320px] mt-0.5" title={doc.lastError}>{doc.lastError}</p>
                                  )}
                                  {progress && (
                                    <div className="flex items-center gap-2 mt-1">
                                      <div className="w-24 h-1 bg-white/10 rounded overflow-hidden">
                                        <div className="h-full bg-[#86C9A4]" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
                                      </div>
                                      <span className="font-mono text-[8px] text-white/45">{progress.done}/{progress.total}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`px-1.5 py-0.5 rounded font-mono text-[8px] font-bold uppercase ${statusTone(doc.status, !!doc.lastError)}`}>
                                {doc.status === "Synced" && !doc.versionNo ? "未索引" : doc.status}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[9px] text-white/45 whitespace-nowrap">
                              {fmtDate(doc.effectiveFrom)} → {fmtDate(doc.effectiveTo)}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[10px] text-white/55 text-right">{doc.vectorsCount}</td>
                            <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-0.5">
                                <button onClick={() => void openDrawer(doc)} className="p-1.5 text-white/40 hover:text-[#86C9A4] cursor-pointer" title="详情">
                                  <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={async () => { try { await reindexOne(doc.id); showToast("重建完成。", "success"); } catch (err) { showToast(err instanceof Error ? err.message : "重建失败。", "error"); } }}
                                  disabled={!!progress}
                                  className="p-1.5 text-white/40 hover:text-[#86C9A4] disabled:opacity-40 cursor-pointer"
                                  title="重建"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${progress ? "animate-spin" : ""}`} />
                                </button>
                                <button onClick={() => deleteDocs([doc.id])} className="p-1.5 text-white/40 hover:text-red-400 cursor-pointer" title="删除">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Bulk bar ───────────────────────────────────────────────── */}
        {selected.size > 0 && (
          <div className="border-t border-white/10 bg-[#0F1216] px-6 py-2.5 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[10px] text-white/70">已选 {selected.size} 篇</span>
            <button onClick={() => setSelected(new Set())} className="font-mono text-[9px] text-white/40 hover:text-white cursor-pointer">取消</button>
            <div className="flex-1" />
            <button onClick={() => void bulkReindex()} className="flex items-center gap-1.5 px-2.5 py-1.5 border border-[#86C9A4]/30 text-[#86C9A4] rounded text-[9px] font-mono uppercase cursor-pointer hover:bg-[#86C9A4]/10">
              <RefreshCw className="w-3 h-3" /> 重建
            </button>
            <select
              onChange={async e => {
                const value = e.target.value;
                if (!value) return;
                const ok = await patchDocs([...selected], { collectionId: value === "__none__" ? null : value });
                showToast(`已移动 ${ok} 篇文档。`, ok > 0 ? "success" : "error");
                e.target.value = "";
              }}
              defaultValue=""
              className="px-2 py-1.5 bg-[#0E1218] border border-white/10 rounded text-[9px] text-white/75 cursor-pointer"
            >
              <option value="" disabled>移动到集合…</option>
              <option value="__none__">未归档</option>
              {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select
              onChange={async e => {
                const value = e.target.value;
                if (!value) return;
                const ok = await patchDocs([...selected], { kind: value });
                showToast(`已设置 ${ok} 篇文档的类型。`, ok > 0 ? "success" : "error");
                e.target.value = "";
              }}
              defaultValue=""
              className="px-2 py-1.5 bg-[#0E1218] border border-white/10 rounded text-[9px] text-white/75 cursor-pointer"
            >
              <option value="" disabled>设类型…</option>
              {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <button onClick={() => setValidityOpen(true)} className="flex items-center gap-1.5 px-2.5 py-1.5 border border-white/15 text-white/70 rounded text-[9px] font-mono uppercase cursor-pointer hover:bg-white/5">
              <CalendarRange className="w-3 h-3" /> 设有效期
            </button>
            <button onClick={() => deleteDocs([...selected])} className="flex items-center gap-1.5 px-2.5 py-1.5 border border-red-400/30 text-red-300 rounded text-[9px] font-mono uppercase cursor-pointer hover:bg-red-400/10">
              <Trash2 className="w-3 h-3" /> 删除
            </button>
          </div>
        )}
      </div>

      {/* ── Detail drawer ─────────────────────────────────────────────── */}
      {drawerDoc && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setDrawerId(null)}>
          <div className="w-full max-w-md h-full bg-[#0F1216] border-l border-white/10 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">{drawerDoc.name}</h3>
                  <p className="font-mono text-[9px] text-white/40 mt-1">
                    {drawerDoc.collectionName ?? "未归档"} · {drawerDoc.kind ?? "document"} · {drawerDoc.docNo ?? "无文号"}
                  </p>
                </div>
                <button onClick={() => setDrawerId(null)} className="text-white/45 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex gap-1 mt-3">
                {(["overview", "versions", "chunks"] as const).map(tab => (
                  <button
                    key={tab} onClick={() => setDrawerTab(tab)}
                    className={`px-2.5 py-1 rounded font-mono text-[9px] uppercase cursor-pointer ${
                      drawerTab === tab ? "bg-[#86C9A4]/15 text-[#86C9A4]" : "text-white/45 hover:bg-white/5"
                    }`}
                  >
                    {tab === "overview" ? "概览" : tab === "versions" ? `版本 ${versions.length}` : "分块"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {isDrawerLoading ? (
                <div className="flex justify-center py-10"><RefreshCw className="w-5 h-5 text-[#86C9A4] animate-spin" /></div>
              ) : drawerTab === "overview" ? (
                <div className="space-y-3">
                  {[
                    ["状态", drawerDoc.status],
                    ["当前版本", drawerDoc.versionNo ? `v${drawerDoc.versionNo}` : "无"],
                    ["向量数", String(drawerDoc.vectorsCount)],
                    ["生命周期", drawerDoc.lifecycle ?? "—"],
                    ["生效", fmtDate(drawerDoc.effectiveFrom)],
                    ["失效", fmtDate(drawerDoc.effectiveTo)],
                    ["标签", (drawerDoc.tags ?? []).join(", ") || "—"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="font-mono text-[9px] uppercase tracking-wider text-white/35">{label}</span>
                      <span className="text-white/80 font-mono">{value}</span>
                    </div>
                  ))}
                  {drawerDoc.lastError && (
                    <div className="mt-2 p-3 rounded-lg bg-red-500/10 border border-red-400/20">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-red-300/80 mb-1">最近一次失败</p>
                      <p className="text-[10px] text-red-200/80 leading-relaxed break-words">{drawerDoc.lastError}</p>
                    </div>
                  )}
                  <div className="pt-3 flex flex-wrap gap-2">
                    <button
                      onClick={async () => { try { await reindexOne(drawerDoc.id); showToast("重建完成。", "success"); } catch (err) { showToast(err instanceof Error ? err.message : "重建失败。", "error"); } }}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-[#86C9A4]/30 text-[#86C9A4] rounded text-[9px] font-mono uppercase cursor-pointer hover:bg-[#86C9A4]/10"
                    >
                      <RefreshCw className="w-3 h-3" /> 重建
                    </button>
                    <button
                      onClick={() => deleteDocs([drawerDoc.id])}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-red-400/30 text-red-300 rounded text-[9px] font-mono uppercase cursor-pointer hover:bg-red-400/10"
                    >
                      <Trash2 className="w-3 h-3" /> 删除
                    </button>
                  </div>
                </div>
              ) : drawerTab === "versions" ? (
                <div className="space-y-2">
                  {versions.length === 0 && <p className="font-mono text-[10px] text-white/40">暂无版本记录。</p>}
                  {versions.map((v, i) => {
                    const row = v as Record<string, unknown>;
                    const no = Number(row.versionNo ?? row.version_no ?? i + 1);
                    const state = String(row.state ?? "?");
                    return (
                      <div key={String(row.id ?? i)} className="p-3 rounded-lg border border-white/10 bg-[#131720]">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] text-[#86C9A4]">v{no}</span>
                          <span className={`font-mono text-[8px] uppercase px-1.5 py-0.5 rounded ${
                            state === "active" ? "bg-[#86C9A4]/15 text-[#86C9A4]" : state === "failed" ? "bg-red-500/15 text-red-300" : "bg-white/10 text-white/50"
                          }`}>{state}</span>
                        </div>
                        <p className="font-mono text-[9px] text-white/45 mt-1">
                          {fmtDate(row.effectiveFrom as string)} → {fmtDate(row.effectiveTo as string)} · {String(row.chunkCount ?? row.chunk_count ?? 0)} 块
                        </p>
                        {row.lastError ? <p className="font-mono text-[8px] text-red-300/70 mt-1 break-words">{String(row.lastError)}</p> : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2">
                  {chunks.length === 0 && <p className="font-mono text-[10px] text-white/40">暂无分块（可能尚未索引）。</p>}
                  {chunks.map((c, i) => (
                    <div key={c.id} className="p-3 rounded-lg border border-white/10 bg-[#131720]">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-[8px] text-[#86C9A4]">#{i + 1}{c.clauseNo ? ` · 第 ${c.clauseNo} 条` : ""}</span>
                        <span className="font-mono text-[8px] text-white/35">{c.tokensCount} tok</span>
                      </div>
                      <p className="text-[10px] text-white/70 font-mono leading-relaxed whitespace-pre-wrap line-clamp-6">{c.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Add document modal ────────────────────────────────────────── */}
      {isNewDocOpen && (
        <form onSubmit={addDocument} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => !isEmbedding && setIsNewDocOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-lg mx-4 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">添加文档</h3>
              {!isEmbedding && <button type="button" onClick={() => setIsNewDocOpen(false)} className="text-white/55 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>}
            </div>
            <input
              value={newDocName} onChange={e => setNewDocName(e.target.value)} placeholder="文档名称" required
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={newDocType} onChange={e => setNewDocType(e.target.value)}
                className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white cursor-pointer focus:outline-none"
              >
                {["Text Document", "PDF Collection", "API Connector"].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select
                value={uploadCollectionId} onChange={e => setUploadCollectionId(e.target.value)}
                className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white cursor-pointer focus:outline-none"
              >
                <option value="">不归档</option>
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <input ref={fileInputRef} type="file" accept=".pdf,.txt,.docx" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleFileUpload(f); e.target.value = ""; }} />
              <button
                type="button" onClick={() => fileInputRef.current?.click()} disabled={isFileParsing}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-white/15 rounded text-[10px] font-mono text-white/50 uppercase tracking-wider hover:border-[#86C9A4]/40 hover:text-[#86C9A4] disabled:opacity-50 cursor-pointer"
              >
                <Upload className="w-4 h-4" /> {isFileParsing ? "解析中…" : "上传 PDF / TXT / DOCX（自动提取正文）"}
              </button>
            </div>
            <textarea
              value={newDocContent} onChange={e => setNewDocContent(e.target.value)} placeholder="也可以直接粘贴正文…" required rows={8}
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] font-mono resize-y"
            />
            <div className="flex justify-end gap-3">
              <button type="button" disabled={isEmbedding} onClick={() => setIsNewDocOpen(false)}
                className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 disabled:opacity-40 cursor-pointer">取消</button>
              <button type="submit" disabled={isEmbedding}
                className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 disabled:opacity-40 cursor-pointer uppercase tracking-widest">
                {isEmbedding ? "索引中…" : "开始索引"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* ── Validity modal ────────────────────────────────────────────── */}
      {validityOpen && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => setValidityOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-sm mx-4 space-y-4">
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">设置有效期（{selected.size} 篇）</h3>
            <label className="block space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-widest text-white/45">生效日期</span>
              <input type="date" value={validityFrom} onChange={e => setValidityFrom(e.target.value)}
                className="w-full px-2.5 py-2 bg-[#0E1218] border border-white/10 rounded text-xs text-white focus:outline-none" />
            </label>
            <label className="block space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-widest text-white/45">失效日期（可空 = 长期有效）</span>
              <input type="date" value={validityTo} onChange={e => setValidityTo(e.target.value)}
                className="w-full px-2.5 py-2 bg-[#0E1218] border border-white/10 rounded text-xs text-white focus:outline-none" />
            </label>
            <label className="block space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-widest text-white/45">生命周期</span>
              <select value={validityLifecycle} onChange={e => setValidityLifecycle(e.target.value)}
                className="w-full px-2.5 py-2 bg-[#0E1218] border border-white/10 rounded text-xs text-white cursor-pointer focus:outline-none">
                {LIFECYCLES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setValidityOpen(false)} className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer">取消</button>
              <button onClick={() => void applyValidity()} className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 cursor-pointer uppercase tracking-widest">应用</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
