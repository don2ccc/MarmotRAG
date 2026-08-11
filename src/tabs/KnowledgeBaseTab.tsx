import { useRef, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import {
  Plus, Search, Upload, FileText, RefreshCw, Trash2, Layers, X, Eye, Pencil,
  Check, ToggleLeft, ToggleRight, Share2, AlertTriangle,
} from "lucide-react";
import { apiFetch } from "../api";
import type { IndexingProgress, SourceDoc } from "../types";

interface Props {
  userId: string;
  sources: SourceDoc[];
  setSources: Dispatch<SetStateAction<SourceDoc[]>>;
  indexingProgress: Record<string, IndexingProgress>;
  setIndexingProgress: Dispatch<SetStateAction<Record<string, IndexingProgress>>>;
  showToast: (message: string, type?: "success" | "info" | "error") => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

/** Subscribe to a /api/sources SSE stream, updating sources list in real-time. */
function subscribeToIndexSSE(
  userId: string,
  url: string,
  body: object,
  setSources: Props["setSources"],
  setIndexingProgress: Props["setIndexingProgress"],
  onStart?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    apiFetch(userId, url, {
      method: "POST",
      body: JSON.stringify(body),
    }).then(async (res) => {
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
            onStart?.();
          } else if (event === "progress") {
            setIndexingProgress(p => ({ ...p, [docId]: { done: data.done, total: data.total } }));
          } else if (event === "done") {
            setSources(prev => prev.map(s => s.id === docId ? { ...s, ...data.doc } : s));
            setIndexingProgress(p => { const n = { ...p }; delete n[docId]; return n; });
            resolve();
          } else if (event === "error") {
            setSources(prev => prev.map(s => s.id === docId ? { ...s, status: "Auth Error" } : s));
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

export default function KnowledgeBaseTab(props: Props) {
  const { userId, sources, setSources, indexingProgress, setIndexingProgress, showToast, showConfirm } = props;

  const [search, setSearch] = useState("");
  const [isNewDocOpen, setIsNewDocOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [newDocType, setNewDocType] = useState("Text Document");
  const [newDocContent, setNewDocContent] = useState("");
  const [isPdfParsing, setIsPdfParsing] = useState(false);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [previewChunks, setPreviewChunks] = useState<{ id: string; text: string; tokensCount: number }[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const filtered = search.trim()
    ? sources.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.type.toLowerCase().includes(search.toLowerCase()))
    : sources;

  const handlePdfUpload = async (file: File) => {
    if (!file) return;
    setIsPdfParsing(true);
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
      const res = await apiFetch(userId, "/api/parse-pdf", {
        method: "POST",
        body: JSON.stringify({ base64 }),
      });
      if (!res.ok) throw new Error("parse failed");
      const data = await res.json();
      setNewDocContent(data.text);
      showToast(`PDF parsed — ${data.pages} page(s).`, "success");
    } catch {
      showToast("Failed to parse PDF.", "error");
    } finally {
      setIsPdfParsing(false);
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
      await subscribeToIndexSSE(userId, "/api/sources", {
        name: newDocName, content: newDocContent, type: newDocType,
      }, setSources, setIndexingProgress);
      showToast("Document indexed successfully!", "success");
      setNewDocName(""); setNewDocContent("");
    } catch (err: any) {
      showToast(err.message || "Embedding failed. Is Ollama running?", "error");
    } finally {
      setIsEmbedding(false);
    }
  };

  const reindex = async (docId: string) => {
    try {
      setSources(prev => prev.map(s => s.id === docId ? { ...s, status: "Syncing..." } : s));
      await subscribeToIndexSSE(userId, `/api/sources/${docId}/reindex`, {}, setSources, setIndexingProgress);
      showToast("Re-indexing complete!", "success");
    } catch {
      showToast("Re-indexing failed. Is Ollama running?", "error");
    }
  };

  const deleteSource = (docId: string) => {
    const doc = sources.find(s => s.id === docId);
    showConfirm("Delete Document", `Delete "${doc?.name ?? docId}"? All indexed vectors will be removed.`, async () => {
      try {
        await apiFetch(userId, `/api/sources/${docId}`, { method: "DELETE" });
        setSources(prev => prev.filter(s => s.id !== docId));
        showToast("Document removed.", "info");
      } catch {
        showToast("Failed to delete document.", "error");
      }
    });
  };

  const toggleShare = async (doc: SourceDoc) => {
    const next = !doc.isShared;
    try {
      const res = await apiFetch(userId, `/api/sources/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isShared: next }),
      });
      if (!res.ok) throw new Error();
      setSources(prev => prev.map(s => s.id === doc.id ? { ...s, isShared: next } : s));
      showToast(next ? "Document shared with the platform." : "Document set to private.", "info");
    } catch {
      showToast("Failed to update sharing.", "error");
    }
  };

  const toggleStatus = async (doc: SourceDoc) => {
    const next = doc.status === "Paused" ? "Synced" : "Paused";
    try {
      const res = await apiFetch(userId, `/api/sources/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error();
      setSources(prev => prev.map(s => s.id === doc.id ? { ...s, status: next } : s));
      showToast(next === "Paused" ? "Source paused." : "Source resumed.", "info");
    } catch {
      showToast("Failed to update source status.", "error");
    }
  };

  const rename = async (docId: string) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      const res = await apiFetch(userId, `/api/sources/${docId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (!res.ok) throw new Error();
      setSources(prev => prev.map(s => s.id === docId ? { ...s, name: renameValue.trim() } : s));
      setRenamingId(null);
      showToast("Source renamed.", "success");
    } catch {
      showToast("Failed to rename source.", "error");
    }
  };

  const openPreview = async (docId: string) => {
    setPreviewSourceId(docId);
    setPreviewChunks([]);
    setIsPreviewLoading(true);
    try {
      const res = await apiFetch(userId, `/api/sources/${docId}/chunks?limit=10`).then(r => r.json());
      setPreviewChunks(res.chunks ?? []);
    } catch {
      showToast("Failed to load chunks.", "error");
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const statusBadge = (s: SourceDoc) => {
    const map: Record<string, string> = {
      "Synced": "bg-[#86C9A4]/15 text-[#86C9A4]",
      "Syncing...": "bg-blue-500/15 text-blue-400",
      "Paused": "bg-yellow-500/15 text-yellow-400",
      "Auth Error": "bg-red-500/15 text-red-400",
    };
    return (
      <span className={`px-2 py-0.5 rounded font-mono text-[9px] font-bold uppercase ${map[s.status] ?? "bg-white/10 text-white/50"}`}>
        {s.status}
      </span>
    );
  };

  return (
    <div className="space-y-6 p-6 md:p-8 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Knowledge Base</h2>
          <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">
            Your documents · shared documents are read-only
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/45" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sources…"
              className="pl-9 pr-4 py-2 bg-[#0E1218] border border-white/10 rounded-lg text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] w-56"
            />
          </div>
          <button
            onClick={() => setIsNewDocOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#86C9A4] text-black text-xs font-bold uppercase tracking-wider rounded-lg hover:brightness-110 cursor-pointer"
          >
            <Plus className="w-4 h-4" /> Add Document
          </button>
        </div>
      </div>

      {filtered.some(s => s.status === "Paused") && (
        <div className="flex items-center gap-2.5 bg-yellow-500/10 border border-yellow-500/25 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-[11px] text-white/70 leading-relaxed">
            <span className="font-bold text-yellow-300">{filtered.filter(s => s.status === "Paused").length}</span>
            {" "}个文档处于 <span className="font-mono text-yellow-300">Paused</span> 状态（向量化中断或待处理）。
            Owner 可在行内点 <span className="font-mono text-[#86C9A4] font-bold">Re-sync</span> 重新索引，或直接删除。
          </p>
        </div>
      )}

      <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-center py-12 text-xs font-mono text-white/45">No documents. Add your first one above.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[9px] uppercase tracking-widest text-white/55">
                <th className="px-4 py-3">Document</th>
                <th className="px-4 py-3 hidden lg:table-cell">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 hidden md:table-cell">Vectors</th>
                <th className="px-4 py-3 hidden md:table-cell">Owner</th>
                <th className="px-4 py-3">Share</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const isOwner = s.ownerId === userId;
                const progress = indexingProgress[s.id];
                return (
                  <tr key={s.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                    <td className="px-4 py-3">
                      {renamingId === s.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") rename(s.id); if (e.key === "Escape") setRenamingId(null); }}
                            className="bg-[#0E1218] border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
                          />
                          <button onClick={() => rename(s.id)} className="text-[#86C9A4] cursor-pointer"><Check className="w-4 h-4" /></button>
                          <button onClick={() => setRenamingId(null)} className="text-white/45 cursor-pointer"><X className="w-4 h-4" /></button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-[#86C9A4] shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-white truncate max-w-[240px]">{s.name}</p>
                            {progress && (
                              <div className="flex items-center gap-2 mt-1">
                                <div className="w-24 h-1 bg-white/10 rounded overflow-hidden">
                                  <div
                                    className="h-full bg-[#86C9A4] transition-all"
                                    style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                                  />
                                </div>
                                <span className="font-mono text-[8px] text-white/55">{progress.done}/{progress.total}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-white/55 hidden lg:table-cell">{s.type}</td>
                    <td className="px-4 py-3">{statusBadge(s)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/60 hidden md:table-cell">{s.vectorsCount}</td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {s.ownerId !== userId && s.isShared ? (
                        <span className="font-mono text-[9px] text-[#86C9A4] bg-[#86C9A4]/10 border border-[#86C9A4]/20 rounded px-1.5 py-0.5 uppercase">
                          Shared · {s.ownerName}
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-white/55">{s.ownerName}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isOwner ? (
                        <button onClick={() => toggleShare(s)} className="flex items-center gap-1.5 cursor-pointer" title={s.isShared ? "Shared — click to make private" : "Private — click to share"}>
                          {s.isShared
                            ? <ToggleRight className="w-5 h-5 text-[#86C9A4]" />
                            : <ToggleLeft className="w-5 h-5 text-white/45" />}
                          <span className={`font-mono text-[9px] uppercase font-bold ${s.isShared ? "text-[#86C9A4]" : "text-white/55"}`}>
                            {s.isShared ? "Shared" : "Private"}
                          </span>
                        </button>
                      ) : s.isShared ? (
                        <span className="flex items-center gap-1.5 font-mono text-[9px] text-white/55 uppercase"><Share2 className="w-3.5 h-3.5" /> Read-only</span>
                      ) : (
                        <span className="font-mono text-[9px] text-white/45 uppercase">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5">
                        {isOwner && s.status === "Paused" && (
                          <button
                            onClick={() => reindex(s.id)}
                            disabled={!!indexingProgress[s.id]}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 mr-1 rounded border border-[#86C9A4]/30 text-[#86C9A4] hover:bg-[#86C9A4]/10 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
                            title="Re-embed chunks and restore this document"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${indexingProgress[s.id] ? "animate-spin" : ""}`} />
                            <span>{indexingProgress[s.id] ? "Syncing…" : "Re-sync"}</span>
                          </button>
                        )}
                        <button onClick={() => openPreview(s.id)} className="p-1.5 text-white/55 hover:text-[#86C9A4] cursor-pointer" title="Preview chunks">
                          <Eye className="w-4 h-4" />
                        </button>
                        {isOwner && (
                          <>
                            <button
                              onClick={() => { setRenamingId(s.id); setRenameValue(s.name); }}
                              className="p-1.5 text-white/55 hover:text-[#86C9A4] cursor-pointer"
                              title="Rename"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            {s.status !== "Paused" && (
                              <>
                                <button onClick={() => reindex(s.id)} className="p-1.5 text-white/55 hover:text-[#86C9A4] cursor-pointer" title="Re-index">
                                  <RefreshCw className="w-4 h-4" />
                                </button>
                                <button onClick={() => toggleStatus(s)} className="p-1.5 text-white/55 hover:text-yellow-400 cursor-pointer" title="Pause">
                                  <AlertTriangle className="w-4 h-4" />
                                </button>
                              </>
                            )}
                            <button onClick={() => deleteSource(s.id)} className="p-1.5 text-white/55 hover:text-red-400 cursor-pointer" title="Delete">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {!isOwner && s.status === "Paused" && (
                          <span className="font-mono text-[9px] text-white/45 uppercase tracking-wider" title="Only the owner can re-sync or delete this document">
                            等待所有者处理
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Document modal */}
      {isNewDocOpen && (
        <form onSubmit={addDocument} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => !isEmbedding && setIsNewDocOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-lg mx-4 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Add Document</h3>
              {!isEmbedding && (
                <button type="button" onClick={() => setIsNewDocOpen(false)} className="text-white/55 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
              )}
            </div>
            <input
              value={newDocName} onChange={e => setNewDocName(e.target.value)} placeholder="Document name" required
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]"
            />
            <select
              value={newDocType} onChange={e => setNewDocType(e.target.value)}
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4] cursor-pointer"
            >
              {["Text Document", "PDF Collection", "Notion Webhook", "G-Drive Archive", "API Connector"].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div>
              <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handlePdfUpload(f); e.target.value = ""; }} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPdfParsing}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-white/15 rounded text-[10px] font-mono text-white/50 uppercase tracking-wider hover:border-[#86C9A4]/40 hover:text-[#86C9A4] disabled:opacity-50 cursor-pointer"
              >
                <Upload className="w-4 h-4" /> {isPdfParsing ? "Parsing PDF…" : "Upload PDF (auto-extract text)"}
              </button>
            </div>
            <textarea
              value={newDocContent} onChange={e => setNewDocContent(e.target.value)} placeholder="Paste text here, or upload a PDF above to auto-fill…" required
              rows={8}
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4] font-mono resize-y"
            />
            <div className="flex justify-end gap-3">
              <button type="button" disabled={isEmbedding} onClick={() => setIsNewDocOpen(false)}
                className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 disabled:opacity-40 cursor-pointer">Cancel</button>
              <button type="submit" disabled={isEmbedding}
                className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 disabled:opacity-40 cursor-pointer uppercase tracking-widest">
                {isEmbedding ? "Embedding…" : "Index Document"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Chunk Preview modal */}
      {previewSourceId !== null && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => setPreviewSourceId(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-2xl mx-4 space-y-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#86C9A4]" /> Chunk Preview — {sources.find(s => s.id === previewSourceId)?.name}
              </h3>
              <button onClick={() => setPreviewSourceId(null)} className="text-white/55 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[10px] text-white/55 font-mono shrink-0">First 10 indexed chunks stored in pgvector.</p>
            <div className="overflow-y-auto space-y-3 flex-1">
              {isPreviewLoading ? (
                <div className="flex items-center justify-center py-10"><RefreshCw className="w-6 h-6 text-[#86C9A4] animate-spin" /></div>
              ) : previewChunks.length === 0 ? (
                <p className="text-xs text-white/45 font-mono text-center py-8">No chunks found. Try re-indexing this document.</p>
              ) : previewChunks.map((c, i) => (
                <div key={c.id} className="bg-[#0E1218] border border-white/10 rounded p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[9px] font-mono text-[#86C9A4] uppercase font-bold">Chunk {i + 1}</span>
                    <span className="text-[9px] font-mono text-white/45">{c.tokensCount} tokens · {c.id}</span>
                  </div>
                  <p className="text-xs text-white/70 font-mono leading-relaxed whitespace-pre-wrap">{c.text}</p>
                </div>
              ))}
            </div>
            <div className="shrink-0 pt-2 border-t border-white/10 flex justify-end">
              <button onClick={() => setPreviewSourceId(null)} className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
