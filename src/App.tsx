import React, { useState, useEffect } from "react";
import {
  Database,
  Sliders,
  Shield,
  LayoutDashboard,
  Users,
  Plus,
  HelpCircle,
  Settings,
  Search,
  Bell,
  Grid,
  ArrowRight,
  MoreVertical,
  Key,
  Network,
  AlertTriangle,
  ChevronRight,
  TrendingUp,
  CheckCircle,
  AlignLeft,
  FileText,
  RefreshCw,
  Layers,
  Server,
  ChevronLeft,
  Filter,
  Play,
  UserPlus,
  Trash2,
  Info,
  Clock,
  TrendingDown,
  Flame,
  Award,
  Sun,
  Moon,
  Pencil,
  X,
  ToggleLeft,
  ToggleRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { SourceDoc, QueryLog, StrategyConfig, TabType, IndexingProgress, Pipeline, PipelineStats } from "./types";

// Custom RAG Response Renderer that beautifully supports HTML hotlinked images & formatting
function SafeRAGResponseRenderer({ text, isDark = true }: { text: string; isDark?: boolean }) {
  if (!text) return null;

  // Regex to match <img ... src="url" ... /> or <img ... src="url" ...>
  // Splitting by this captures the whole tag in group 1, and the URL in group 2.
  const imgRegex = /(<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>)/gi;
  const parts = text.split(imgRegex);
  const renderedElements: React.ReactNode[] = [];
  
  let i = 0;
  while (i < parts.length) {
    const segment = parts[i];
    
    if (segment === undefined || segment === null) {
      i++;
      continue;
    }
    
    // Check if this segment is a captured image tag
    if (segment.toLowerCase().startsWith("<img")) {
      const srcUrl = parts[i + 1] || "";
      const altMatch = segment.match(/alt=["']([^"']+)["']/i);
      const altText = altMatch ? altMatch[1] : "RAG Hotlinked Diagram";
      
      renderedElements.push(
        <div key={`img-${i}`} className="my-4 flex flex-col gap-2 bg-black/60 p-4 rounded border border-white/10 max-w-xl">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 bg-[#ccff00] rounded-sm"></div>
            <span className="text-[9px] font-mono uppercase text-white/60 tracking-wider">Image link identified for hotlinking</span>
          </div>
          <img 
            src={srcUrl} 
            alt={altText}
            referrerPolicy="no-referrer"
            className="w-full h-auto rounded border border-dashed border-white/20 object-cover max-h-[320px] transition-transform hover:scale-[1.01]"
          />
          <span className="text-[10px] text-[#ccff00] font-mono text-center italic mt-1 flex items-center justify-center gap-1 font-semibold">
            <Info className="w-3 h-3 text-[#ccff00]" />
            Hotlinked: {altText}
          </span>
        </div>
      );
      i += 2;
    } else {
      // Standard text segment. We parse paragraph styles, list items, and basic bold text.
      const lines = segment.split("\n");
      renderedElements.push(
        <div key={`text-${i}`} className="space-y-3 leading-relaxed">
          {lines.map((line, lineIdx) => {
            const trimmed = line.trim();
            if (!trimmed) return <div key={lineIdx} className="h-2"></div>;
            
            if (trimmed.startsWith("###")) {
              return (
                <h4 key={lineIdx} className="text-xs font-display font-bold mt-4 mb-1 text-[#ccff00] uppercase tracking-widest">
                  {trimmed.replace("###", "").trim()}
                </h4>
              );
            }
            if (trimmed.startsWith("##")) {
              return (
                <h3 key={lineIdx} className="text-sm font-display font-semibold mt-5 mb-2 text-white uppercase tracking-wider">
                  {trimmed.replace("##", "").trim()}
                </h3>
              );
            }
            if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
              return (
                <ul key={lineIdx} className="list-disc pl-5 my-1.5 text-white/80 font-serif italic text-sm border-l border-white/10 ml-1">
                  <li>{trimmed.replace(/^[-*]\s*/, "")}</li>
                </ul>
              );
            }
            
            return (
              <p key={lineIdx} className="text-sm text-white/90 font-serif leading-relaxed italic border-l-2 border-[#ccff00] pl-4 py-1.5 my-2">
                {line}
              </p>
            );
          })}
        </div>
      );
      i++;
    }
  }
  
  return <div className="space-y-2">{renderedElements}</div>;
}

type PipelineWithStats = Pipeline & { stats: PipelineStats & { pipelineId?: string } };

export default function App() {
  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const [activeTab, setActiveTab] = useState<TabType>("dashboard");
  const [sources, setSources] = useState<SourceDoc[]>([]);
  const [logs, setLogs] = useState<QueryLog[]>([]);
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [healthStatus, setHealthStatus] = useState<{ pgConnected?: boolean; ollamaConnected?: boolean; geminiActive?: boolean; pgHost?: string; pgDatabase?: string; ollamaBaseUrl?: string } | null>(null);
  const [pipelines, setPipelines] = useState<PipelineWithStats[]>([]);

  // Pipeline editor state
  const [isPipelineDrawerOpen, setIsPipelineDrawerOpen] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<PipelineWithStats | null>(null);
  const [pipelineForm, setPipelineForm] = useState<Partial<Pipeline>>({});
  const [pipelineSaving, setPipelineSaving] = useState(false);
  
  // App UI state
  const [searchQuery, setSearchQuery] = useState("");
  const [kbSearchQuery, setKbSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "info" | "error" } | null>(null);
  
  // Index New Doc state
  const [isNewDocOpen, setIsNewDocOpen] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [newDocType, setNewDocType] = useState("PDF Collection");
  const [newDocContent, setNewDocContent] = useState("");
  const [isPdfParsing, setIsPdfParsing] = useState(false);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  // Per-document live indexing progress: { [docId]: IndexingProgress }
  const [indexingProgress, setIndexingProgress] = useState<Record<string, IndexingProgress>>({});

  // Add User state
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState("Viewer");

  // RAG Playground state
  const [playgroundQuery, setPlaygroundQuery] = useState("");
  const [playgroundPipeline, setPlaygroundPipeline] = useState("Doc-Search-Alpha");
  const [playgroundResult, setPlaygroundResult] = useState<QueryLog | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);

  // Expanded log row in logs list
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Unsaved Config state
  const [hasUnsavedConfig, setHasUnsavedConfig] = useState(false);
  const [pendingConfig, setPendingConfig] = useState<any>(null);

  // Load All Initial Data
  const loadData = async () => {
    try {
      const [resSources, resLogs, resConfig, resUsers, resHealth, resPipelines] = await Promise.all([
        fetch("/api/sources").then(r => r.json()),
        fetch("/api/logs").then(r => r.json()),
        fetch("/api/config").then(r => r.json()),
        fetch("/api/users").then(r => r.json()),
        fetch("/api/health").then(r => r.json()),
        fetch("/api/pipelines").then(r => r.json()),
      ]);
      setSources(resSources);
      setLogs(resLogs);
      setConfig(resConfig);
      setPendingConfig(resConfig);
      setUsers(resUsers);
      setHealthStatus(resHealth);
      setPipelines(resPipelines);
    } catch (err) {
      console.error("Error loading API data:", err);
      showToast("Error connecting to server. Make sure dev server is running.", "error");
    }
  };

  const refreshPipelines = () =>
    fetch("/api/pipelines").then(r => r.json()).then(setPipelines).catch(() => {});

  useEffect(() => {
    loadData();
    const timer = setInterval(() => {
      fetch("/api/health").then(r => r.json()).then(setHealthStatus).catch(() => {});
      refreshPipelines();
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (themeMode === "light") {
      document.body.classList.add("theme-light");
      document.body.classList.remove("theme-dark");
    } else {
      document.body.classList.add("theme-dark");
      document.body.classList.remove("theme-light");
    }
  }, [themeMode]);

  const showToast = (message: string, type: "success" | "info" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  /** Subscribe to a /api/sources SSE stream, updating sources list in real-time. */
  const subscribeToIndexSSE = (url: string, body: object, onStart?: () => void) => {
    return new Promise<void>((resolve, reject) => {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) {
          // Non-SSE error response (e.g. 409 duplicate name) — parse JSON message
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
  };

  // Add a document (Upload & Chunk) — streams progress via SSE
  const handleAddDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim() || !newDocContent.trim()) {
      showToast("Please fill in document name and text content.", "error");
      return;
    }

    setIsLoading(true);
    // Close form immediately — progress is visible in the table
    setIsNewDocOpen(false);
    setPdfPageCount(null);

    try {
      await subscribeToIndexSSE("/api/sources", {
        name: newDocName, content: newDocContent, type: newDocType
      });
      showToast(`Document indexed successfully!`, "success");
      setNewDocName("");
      setNewDocContent("");
    } catch (err) {
      console.error(err);
      showToast("Embedding failed. Is Ollama running?", "error");
    } finally {
      setIsLoading(false);
    }
  };

  // Re-index an existing document
  const handleReindex = async (docId: string) => {
    try {
      setSources(prev => prev.map(s => s.id === docId ? { ...s, status: "Syncing..." } : s));
      await subscribeToIndexSSE(`/api/sources/${docId}/reindex`, {});
      showToast("Re-indexing complete!", "success");
    } catch (err) {
      showToast("Re-indexing failed. Is Ollama running?", "error");
    }
  };

  // Delete a source document
  const handleDeleteSource = async (docId: string) => {
    try {
      await fetch(`/api/sources/${docId}`, { method: "DELETE" });
      setSources(prev => prev.filter(s => s.id !== docId));
      showToast("Document removed from knowledge base.", "info");
    } catch (err) {
      showToast("Failed to delete document.", "error");
    }
  };

  // Perform RAG Query (Chat / Search)
  const handlePlaygroundQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playgroundQuery.trim()) return;

    setIsQuerying(true);
    setPlaygroundResult(null);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: playgroundQuery,
          pipeline: playgroundPipeline
        })
      });

      if (!res.ok) throw new Error("Query processing failed");

      const logResult = await res.json();
      setPlaygroundResult(logResult);
      // Prepend to current logs list as well
      setLogs(prev => [logResult, ...prev]);
      showToast("Query completed with context-grounded response!", "success");
    } catch (err) {
      console.error(err);
      showToast("Failed to process RAG query.", "error");
    } finally {
      setIsQuerying(false);
    }
  };

  // Test connection
  const [testingConnection, setTestingConnection] = useState(false);
  const handleTestConnectivity = async () => {
    setTestingConnection(true);
    try {
      const res = await fetch("/api/test-connectivity", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, "success");
      }
    } catch (err) {
      showToast("Connectivity test failed.", "error");
    } finally {
      setTestingConnection(false);
    }
  };

  // Save Strategy Config
  const handleSaveConfig = async () => {
    if (!pendingConfig) return;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingConfig)
      });
      if (!res.ok) throw new Error("Save config failed");
      const data = await res.json();
      setConfig(data.config);
      setHasUnsavedConfig(false);
      showToast("Enterprise Strategy updated and re-indexing scheduled!", "success");
    } catch (err) {
      showToast("Failed to update strategy config.", "error");
    }
  };

  // Discard Config Changes
  const handleDiscardConfig = () => {
    setPendingConfig(config);
    setHasUnsavedConfig(false);
    showToast("Unsaved configuration changes discarded.", "info");
  };

  // ─── Pipeline CRUD handlers ───────────────────────────────────────────────
  const openNewPipeline = () => {
    setEditingPipeline(null);
    setPipelineForm({ name: "", description: "", generationModel: "gemini-3.5-flash", topK: 3, minScore: 0.0, systemPrompt: "", sourceFilter: [], enabled: true });
    setIsPipelineDrawerOpen(true);
  };
  const openEditPipeline = (p: PipelineWithStats) => {
    setEditingPipeline(p);
    setPipelineForm({ ...p });
    setIsPipelineDrawerOpen(true);
  };
  const handleSavePipeline = async () => {
    setPipelineSaving(true);
    try {
      const method = editingPipeline ? "PUT" : "POST";
      const url = editingPipeline ? `/api/pipelines/${editingPipeline.id}` : "/api/pipelines";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(pipelineForm) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      await refreshPipelines();
      setIsPipelineDrawerOpen(false);
      showToast(editingPipeline ? "Pipeline updated." : "Pipeline created.", "success");
    } catch (err: any) {
      showToast(err.message || "Failed to save pipeline.", "error");
    } finally {
      setPipelineSaving(false);
    }
  };
  const handleDeletePipeline = async (id: string) => {
    try {
      await fetch(`/api/pipelines/${id}`, { method: "DELETE" });
      await refreshPipelines();
      showToast("Pipeline deleted.", "info");
    } catch { showToast("Failed to delete pipeline.", "error"); }
  };
  const handleTogglePipelineEnabled = async (p: PipelineWithStats) => {
    try {
      await fetch(`/api/pipelines/${p.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !p.enabled }) });
      await refreshPipelines();
    } catch { showToast("Failed to toggle pipeline.", "error"); }
  };
  // ─────────────────────────────────────────────────────────────────────────

  // Manage Users
  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserName || !newUserEmail) return;
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newUserName, email: newUserEmail, role: newUserRole })
      });
      const data = await res.json();
      setUsers(prev => [...prev, data]);
      setNewUserName("");
      setNewUserEmail("");
      setIsAddUserOpen(false);
      showToast(`User ${data.name} added to Alpha-Team workspace!`, "success");
    } catch (err) {
      showToast("Failed to add user.", "error");
    }
  };

  const handleDeleteUser = async (id: string) => {
    try {
      await fetch(`/api/users/${id}`, { method: "DELETE" });
      setUsers(prev => prev.filter(u => u.id !== id));
      showToast("User removed successfully.", "info");
    } catch (err) {
      showToast("Failed to delete user.", "error");
    }
  };

  // Toggle SSO
  const handleToggleSSO = (checked: boolean) => {
    const updated = { ...pendingConfig, ssoEnabled: checked };
    setPendingConfig(updated);
    setHasUnsavedConfig(true);
  };

  // Update Config Inputs
  const handleConfigChange = (key: string, value: any) => {
    const updated = { ...pendingConfig, [key]: value };
    setPendingConfig(updated);
    setHasUnsavedConfig(true);
  };

  // Filtering active documents
  const filteredSources = sources.filter(doc => 
    doc.name.toLowerCase().includes(kbSearchQuery.toLowerCase()) ||
    doc.content.toLowerCase().includes(kbSearchQuery.toLowerCase())
  );

  return (
    <div className="flex min-h-screen bg-[#050505] text-[#f0f0f0] font-sans overflow-hidden">
      {/* Toast Alert */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={`fixed top-4 right-4 z-50 p-4 rounded border ${
              toast.type === "success" ? "bg-black border-[#ccff00] text-white" :
              toast.type === "error" ? "bg-black border-red-500 text-white" :
              "bg-black border-white/20 text-white"
            }`}
          >
            {toast.type === "success" && <CheckCircle className="w-5 h-5 text-[#ccff00]" />}
            {toast.type === "error" && <AlertTriangle className="w-5 h-5 text-red-500" />}
            {toast.type === "info" && <Info className="w-5 h-5 text-white/80" />}
            <span className="text-xs font-mono font-bold tracking-tight">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SideNavBar (Desktop Sidebar) */}
      <aside className="hidden md:flex flex-col h-screen py-6 px-4 gap-6 border-r border-white/10 bg-[#080808] w-64 fixed left-0 top-0 z-20">
        <div className="flex items-center gap-3 px-1 mb-2">
          <div className="w-9 h-9 bg-[#ccff00] rounded-full flex items-center justify-center shrink-0">
            <span className="font-display text-sm font-extrabold text-black uppercase tracking-tighter">M</span>
          </div>
          <div>
            <h1 className="font-display text-sm font-bold tracking-tighter uppercase text-white leading-none">Marmot RAG</h1>
            <p className="font-mono text-[9px] text-[#ccff00] uppercase tracking-wider font-bold mt-1.5">98.4% SHARD_SYNC_OK</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5">
          {/* Dashboard Tab */}
          <button 
            onClick={() => setActiveTab("dashboard")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-semibold transition-all text-left ${
              activeTab === "dashboard" 
                ? "text-black bg-[#ccff00]" 
                : "text-white/60 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span>Analytics Dashboard</span>
          </button>

          {/* Workspace Tab */}
          <button 
            onClick={() => setActiveTab("workspace")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-semibold transition-all text-left ${
              activeTab === "workspace" 
                ? "text-black bg-[#ccff00]" 
                : "text-white/60 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Workspace Config</span>
          </button>

          {/* Knowledge Base Tab */}
          <button 
            onClick={() => setActiveTab("knowledge-base")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-semibold transition-all text-left ${
              activeTab === "knowledge-base" 
                ? "text-black bg-[#ccff00]" 
                : "text-white/60 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <Database className="w-4 h-4" />
            <span>Knowledge Base</span>
          </button>

          {/* Admin Tab */}
          <button 
            onClick={() => setActiveTab("admin")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-semibold transition-all text-left ${
              activeTab === "admin" 
                ? "text-black bg-[#ccff00]" 
                : "text-white/60 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>Global Admin</span>
          </button>

          {/* RAG Playground Tab */}
          <button 
            onClick={() => setActiveTab("playground")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-semibold transition-all text-left ${
              activeTab === "playground" 
                ? "text-black bg-[#ccff00]" 
                : "text-white/60 hover:bg-white/[0.04] hover:text-[#ccff00]"
            }`}
          >
            <Flame className={`w-4 h-4 ${activeTab === "playground" ? "text-black" : "text-[#ccff00]"}`} />
            <span>RAG Playground</span>
          </button>
        </nav>

        {/* Action Button */}
        <button 
          onClick={() => {
            setActiveTab("knowledge-base");
            setIsNewDocOpen(true);
          }}
          className="bg-white hover:bg-white/90 text-black py-2 px-4 rounded text-xs font-bold flex items-center justify-center gap-1.5 transition-all uppercase tracking-widest"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Document
        </button>

        <div className="pt-4 border-t border-white/10 space-y-1">
          <a href="#" className="flex items-center gap-3 px-3 py-2 rounded text-white/50 text-xs font-semibold hover:bg-white/[0.04] hover:text-white transition-all">
            <HelpCircle className="w-4 h-4" />
            <span>Help System</span>
          </a>
          <button 
            onClick={() => {
              setActiveTab("admin");
              showToast("Opening settings control panel", "info");
            }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded text-white/50 text-xs font-semibold hover:bg-white/[0.04] hover:text-white text-left transition-all"
          >
            <Settings className="w-4 h-4" />
            <span>Workspace Settings</span>
          </button>
          <button 
            onClick={() => {
              setThemeMode(themeMode === "light" ? "dark" : "light");
              showToast(`Switched to ${themeMode === "light" ? "Dark Theme" : "Light Theme"} mode.`, "success");
            }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded text-white/50 text-xs font-semibold hover:bg-white/[0.04] hover:text-white text-left transition-all"
          >
            {themeMode === "light" ? (
              <>
                <Moon className="w-4 h-4 text-[#ccff00]" />
                <span>Use Dark Theme</span>
              </>
            ) : (
              <>
                <Sun className="w-4 h-4 text-amber-400" />
                <span>Use Light Theme</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main Content Layout */}
      <main className="flex-1 md:ml-64 bg-[#0c0c0c] min-h-screen pb-20 md:pb-8 flex flex-col">
        {/* TopNavBar */}
        <header className="flex justify-between items-center w-full px-6 md:px-12 h-16 sticky top-0 bg-[#080808]/90 backdrop-blur z-10 border-b border-white/10">
          <div className="flex items-center gap-4">
            <span className="font-display text-sm font-bold uppercase tracking-widest text-white">Pipeline Control Plane</span>
            <div className="relative hidden sm:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 w-3.5 h-3.5" />
              <input 
                type="text" 
                placeholder="Global query parameters..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-1.5 bg-white/5 border border-white/10 rounded text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#ccff00] focus:bg-white/10 transition-all outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Theme Toggle Button */}
            <button 
              onClick={() => {
                setThemeMode(themeMode === "light" ? "dark" : "light");
                showToast(`Switched to ${themeMode === "light" ? "Dark Theme" : "Light Theme"} mode.`, "success");
              }}
              title={`Switch to ${themeMode === "light" ? "Dark Theme" : "Light Theme"}`}
              className="p-1.5 rounded hover:bg-white/5 transition-all text-white/70 flex items-center gap-1.5 border border-white/10 bg-white/5 cursor-pointer"
            >
              {themeMode === "light" ? (
                <>
                  <Moon className="w-4 h-4 text-[#ccff00]" />
                  <span className="text-[10px] font-mono font-bold uppercase hidden md:inline">Dark Mode</span>
                </>
              ) : (
                <>
                  <Sun className="w-4 h-4 text-amber-500" />
                  <span className="text-[10px] font-mono font-bold uppercase hidden md:inline text-slate-700">Light Mode</span>
                </>
              )}
            </button>

            <button 
              onClick={() => showToast("Database synchronization online.", "info")}
              className="p-2 rounded hover:bg-white/5 transition-colors text-white/70 relative"
            >
              <Bell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-[#ccff00] rounded-full"></span>
            </button>
            <button className="p-2 rounded hover:bg-white/5 transition-colors text-white/70">
              <Grid className="w-4 h-4" />
            </button>
            
            <div className="w-px h-6 bg-white/10 mx-1"></div>

            <div className="flex items-center gap-2 cursor-pointer hover:bg-white/5 p-1.5 rounded transition-all">
              <img 
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuCUZfI40ZWgWIDJa9qAzScBenlksgTyw_ZjF1AYj9rj4vCTl6wZxKDgFBZpZlSBlYev_bfIafWaYRsnrWPZBoAc0ZbuwqbkwPXveoPjiO_YWKUF0Y4kefUnFCO6PdAN3kzoe6izqFyK2vK5zfYVlcZPQJdAgJshkBloQ6ERj6IhwjyffFbxRfbjqH03mzWd_9zHkPUEefX1dr6O20QnzW3vjN2U23n40Nt2nVNcnYrymJjWwbdsGeaa" 
                alt="Profile Headshot"
                referrerPolicy="no-referrer"
                className="w-8 h-8 rounded-full border border-white/10 object-cover" 
              />
              <div className="hidden sm:block text-left">
                <p className="text-xs font-bold leading-none text-white">Alex Rivera</p>
                <p className="text-[10px] text-white/40 font-mono mt-1 uppercase tracking-widest font-bold">Lead Architect</p>
              </div>
            </div>
          </div>
        </header>

        {/* Content Area Routing */}
        <div className="px-6 md:px-12 py-8 max-w-[1440px] mx-auto w-full flex-grow">
          {activeTab === "workspace" && (
            <div className="space-y-8 animate-in fade-in duration-300">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="bg-[#ccff00]/10 text-[#ccff00] text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded font-mono border border-[#ccff00]/20">Active Strategy</span>
                    <span className="text-white/40 text-[11px] font-semibold font-mono">ID: STRAT-992-BETA</span>
                  </div>
                  <h2 className="font-display text-2xl font-extrabold text-white tracking-tight">Workspace Strategy: <span className="text-[#ccff00]">High-Precision Neural</span></h2>
                  <p className="text-white/60 text-xs mt-1.5 max-w-2xl font-medium">
                    Configure document decomposition logic and vector database connectivity parameters for optimized semantic retrieval. Settings are persisted to the <span className="font-bold text-white">Alpha-Team</span> workspace.
                  </p>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={handleDiscardConfig}
                    className="px-4 py-2 border border-white/10 text-white font-semibold text-xs rounded bg-white/5 hover:bg-white/10 transition-all soft-card"
                  >
                    Discard Changes
                  </button>
                  <button 
                    onClick={handleSaveConfig}
                    className="px-4 py-2 bg-[#ccff00] text-black font-bold text-xs rounded hover:opacity-90 transition-all soft-card flex items-center gap-2"
                  >
                    <CheckCircle className="w-4 h-4 text-black" />
                    Save Strategy
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left: Chunking config */}
                <div className="lg:col-span-7 flex flex-col gap-8">
                  {/* Chunking Configuration Card */}
                  <section className="bg-[#080808] p-6 rounded soft-card flex flex-col gap-4 border border-white/10">
                    <div className="flex items-center gap-3 border-b border-white/10 pb-4 mb-2">
                      <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                        <AlignLeft className="w-5 h-5" />
                      </div>
                      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Chunking Configuration</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      {/* Chunk Size Slider */}
                      <div className="flex flex-col gap-2">
                        <label className="text-xs font-bold text-white uppercase tracking-wider">Chunk Size (Tokens)</label>
                        <p className="text-[11px] text-white/40 leading-normal">Recommended: 256 - 1024 tokens for balanced semantic density.</p>
                        <div className="mt-4">
                          <input 
                            type="range" 
                            min="128" 
                            max="2048" 
                            step="128"
                            value={pendingConfig?.chunkSize || 512}
                            onChange={(e) => handleConfigChange("chunkSize", parseInt(e.target.value))}
                            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#ccff00]"
                          />
                          <div className="flex justify-between mt-2 font-mono text-[10px] text-white/40">
                            <span>128</span>
                            <span className="text-xs font-bold text-[#ccff00] font-mono">{pendingConfig?.chunkSize || 512} tokens</span>
                            <span>2048</span>
                          </div>
                        </div>
                      </div>

                      {/* Chunk Overlap Slider */}
                      <div className="flex flex-col gap-2">
                        <label className="text-xs font-bold text-white uppercase tracking-wider">Chunk Overlap (%)</label>
                        <p className="text-[11px] text-white/40 leading-normal">Ensures context continuity between adjacent document segments.</p>
                        <div className="mt-4">
                          <input 
                            type="range" 
                            min="0" 
                            max="50" 
                            step="5"
                            value={pendingConfig?.chunkOverlap || 15}
                            onChange={(e) => handleConfigChange("chunkOverlap", parseInt(e.target.value))}
                            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#ccff00]"
                          />
                          <div className="flex justify-between mt-2 font-mono text-[10px] text-white/40">
                            <span>0%</span>
                            <span className="text-xs font-bold text-[#ccff00] font-mono">{pendingConfig?.chunkOverlap || 15}% overlap</span>
                            <span>50%</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 p-4 bg-white/5 border border-white/5 rounded flex items-center gap-3">
                      <Info className="w-5 h-5 text-[#ccff00] flex-shrink-0" />
                      <p className="text-[11px] text-white/60">
                        Changing these parameters will trigger an <span className="font-bold text-[#ccff00] font-mono">automatic re-indexing</span> of all documents in the active workspace.
                      </p>
                    </div>
                  </section>

                  {/* Separation Strategy Card */}
                  <section className="bg-[#080808] p-6 rounded soft-card flex flex-col gap-4 border border-white/10">
                    <div className="flex items-center gap-3 border-b border-white/10 pb-4 mb-2">
                      <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                        <FileText className="w-5 h-5" />
                      </div>
                      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Separation Strategy</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {["Semantic", "Fixed", "Recursive"].map((strat) => (
                        <div 
                          key={strat}
                          onClick={() => handleConfigChange("separationStrategy", strat)}
                          className={`p-4 rounded border cursor-pointer transition-all ${
                            pendingConfig?.separationStrategy === strat 
                              ? "border-[#ccff00] bg-[#ccff00]/5" 
                              : "border-white/10 bg-black/40 hover:border-white/20"
                          }`}
                        >
                          <h4 className={`text-xs font-bold uppercase tracking-wider ${pendingConfig?.separationStrategy === strat ? "text-[#ccff00]" : "text-white"}`}>{strat}</h4>
                          <p className="text-[10px] text-white/50 mt-2 leading-normal">
                            {strat === "Semantic" && "Breaks text at natural boundaries dynamically."}
                            {strat === "Fixed" && "Strict chunk size limit boundary enforcement."}
                            {strat === "Recursive" && "Iterative splitting recursively based on characters."}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>

                {/* Right: Vector Store + Embedding Model */}
                <div className="lg:col-span-5 flex flex-col gap-8">

                  {/* pgvector Card */}
                  <section className="bg-[#080808] p-6 rounded soft-card flex flex-col gap-4 border border-white/10">
                    <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                          <Server className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Vector Store</h3>
                          <p className="text-[10px] text-white/40 font-mono mt-0.5">PostgreSQL + pgvector (Local)</p>
                        </div>
                      </div>
                      <span className={`flex items-center gap-1.5 text-[9px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${
                        healthStatus?.pgConnected
                          ? "text-[#ccff00] bg-[#ccff00]/5 border-[#ccff00]/25"
                          : "text-red-400 bg-red-500/5 border-red-500/20"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${healthStatus?.pgConnected ? "bg-[#ccff00] animate-pulse" : "bg-red-400"}`}></span>
                        {healthStatus?.pgConnected ? "Connected" : healthStatus === null ? "Checking…" : "Disconnected"}
                      </span>
                    </div>

                    <div className="space-y-3">
                      {[
                        { label: "Host", value: pendingConfig?.pgHost || "127.0.0.1" },
                        { label: "Port", value: pendingConfig?.pgPort || "5432" },
                        { label: "Database", value: pendingConfig?.pgDatabase || "ai_hub" },
                        { label: "Table", value: pendingConfig?.pgTable || "marmot_chunks" },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex items-center justify-between py-2 border-b border-white/5">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">{label}</span>
                          <span className="text-xs font-mono text-white font-semibold">{value}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between py-2 border-b border-white/5">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Vector Dimensions</span>
                        <span className="text-xs font-mono text-[#ccff00] font-bold">768-dim (nomic)</span>
                      </div>
                      <div className="flex items-center justify-between py-2">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Index Type</span>
                        <span className="text-xs font-mono text-white/70 font-semibold">IVFFlat · cosine ops</span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-white/10">
                      <button
                        onClick={handleTestConnectivity}
                        disabled={testingConnection}
                        className="w-full py-2.5 border border-dashed border-white/15 hover:border-[#ccff00] hover:text-[#ccff00] text-white/60 text-xs font-bold rounded transition-all flex items-center justify-center gap-2 cursor-pointer bg-white/5 hover:bg-white/10"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${testingConnection ? "animate-spin" : ""}`} />
                        {testingConnection ? "Testing..." : "Test DB Connection"}
                      </button>
                    </div>
                  </section>

                  {/* Ollama Embedding Model Card */}
                  <section className="bg-[#080808] p-6 rounded soft-card flex flex-col gap-4 border border-white/10">
                    <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                          <Layers className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Embedding Model</h3>
                          <p className="text-[10px] text-white/40 font-mono mt-0.5">Ollama (Local Inference)</p>
                        </div>
                      </div>
                      <span className={`flex items-center gap-1.5 text-[9px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${
                        healthStatus?.ollamaConnected
                          ? "text-[#ccff00] bg-[#ccff00]/5 border-[#ccff00]/25"
                          : "text-red-400 bg-red-500/5 border-red-500/20"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${healthStatus?.ollamaConnected ? "bg-[#ccff00] animate-pulse" : "bg-red-400"}`}></span>
                        {healthStatus?.ollamaConnected ? "Running" : healthStatus === null ? "Checking…" : "Offline"}
                      </span>
                    </div>

                    <div className="space-y-3">
                      {[
                        { label: "Provider", value: "Ollama (Local)" },
                        { label: "Model", value: pendingConfig?.embeddingModel || "nomic-embed-text:latest" },
                        { label: "Dimensions", value: `${pendingConfig?.embeddingDimension || 768}` },
                        { label: "Base URL", value: pendingConfig?.ollamaBaseUrl || "http://localhost:11434" },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex items-center justify-between py-2 border-b border-white/5">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">{label}</span>
                          <span className="text-xs font-mono text-white font-semibold truncate max-w-[180px] text-right">{value}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between py-2">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Generation Model</span>
                        <span className={`text-xs font-mono font-bold ${healthStatus?.geminiActive ? "text-[#ccff00]" : "text-white/40"}`}>
                          {healthStatus?.geminiActive ? "gemini-3.5-flash ✓" : "gemini (no key)"}
                        </span>
                      </div>
                    </div>

                    <div className="p-3 bg-white/5 border border-white/10 rounded flex items-start gap-2">
                      <Info className="w-4 h-4 text-[#ccff00] flex-shrink-0 mt-0.5" />
                      <p className="text-[10px] text-white/50 leading-relaxed">
                        To change the embedding model, update <span className="font-mono text-white/70">OLLAMA_BASE_URL</span> in your <span className="font-mono text-white/70">.env</span> file and restart the server. The vector dimension must remain <span className="font-mono text-[#ccff00]">768</span> to match existing stored embeddings.
                      </p>
                    </div>
                  </section>
                </div>
              </div>

              {/* External / Cloud Vector DB — Optional Extension */}
              <section className="bg-[#080808] p-6 rounded soft-card border border-white/10">
                <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-6">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-white/40">
                      <Network className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">External Vector DB</h3>
                      <p className="text-[10px] text-white/40 font-mono mt-0.5">Optional — Cloud / SaaS vector store integration (reserved interface)</p>
                    </div>
                  </div>
                  {/* Enable toggle */}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <span className="text-[10px] font-mono uppercase text-white/40 font-bold">
                      {pendingConfig?.externalVectorDb?.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={pendingConfig?.externalVectorDb?.enabled ?? false}
                        onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, enabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-white/10 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-black after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#ccff00]"></div>
                    </div>
                  </label>
                </div>

                <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 transition-opacity duration-200 ${pendingConfig?.externalVectorDb?.enabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
                  {/* Provider select */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Provider</label>
                    <select
                      value={pendingConfig?.externalVectorDb?.provider || "Pinecone"}
                      onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, provider: e.target.value })}
                      className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-sans text-white focus:ring-1 focus:ring-[#ccff00] outline-none"
                    >
                      <option>Pinecone</option>
                      <option>Weaviate</option>
                      <option>Qdrant</option>
                      <option>Milvus</option>
                      <option>Zilliz Cloud</option>
                      <option>Supabase pgvector</option>
                      <option>Azure AI Search</option>
                      <option>Elasticsearch</option>
                      <option>Custom</option>
                    </select>
                  </div>

                  {/* API Endpoint */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">API Endpoint / Host</label>
                    <input
                      type="text"
                      placeholder="https://your-index.pinecone.io"
                      value={pendingConfig?.externalVectorDb?.apiEndpoint || ""}
                      onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, apiEndpoint: e.target.value })}
                      className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-mono text-white focus:ring-1 focus:ring-[#ccff00] outline-none placeholder-white/20"
                    />
                  </div>

                  {/* Index / Collection Name */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Index / Collection Name</label>
                    <input
                      type="text"
                      placeholder="marmot-rag-prod"
                      value={pendingConfig?.externalVectorDb?.indexName || ""}
                      onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, indexName: e.target.value })}
                      className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-mono text-white focus:ring-1 focus:ring-[#ccff00] outline-none placeholder-white/20"
                    />
                  </div>

                  {/* API Key */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">API Key / Token</label>
                    <input
                      type="password"
                      placeholder="sk-••••••••••••••••"
                      value={pendingConfig?.externalVectorDb?.apiKey || ""}
                      onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, apiKey: e.target.value })}
                      className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-mono text-white focus:ring-1 focus:ring-[#ccff00] outline-none placeholder-white/20"
                    />
                  </div>

                  {/* Notes */}
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Notes</label>
                    <input
                      type="text"
                      placeholder="e.g. Production cluster, us-east-1, dim=768"
                      value={pendingConfig?.externalVectorDb?.notes || ""}
                      onChange={(e) => handleConfigChange("externalVectorDb", { ...pendingConfig?.externalVectorDb, notes: e.target.value })}
                      className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-sans text-white focus:ring-1 focus:ring-[#ccff00] outline-none placeholder-white/20"
                    />
                  </div>
                </div>

                {/* Status note */}
                <div className="mt-5 p-3 bg-white/5 border border-white/10 rounded flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-[10px] text-white/50 leading-relaxed">
                    This is a <span className="font-bold text-white/70">reserved configuration interface</span>. Toggling it on saves the credentials but does not yet switch the active vector store — the system continues using local pgvector. Future versions will support live routing between local and cloud backends.
                  </p>
                </div>
              </section>

              {/* Floating Save Bar */}
              <AnimatePresence>
                {hasUnsavedConfig && (
                  <motion.div 
                    initial={{ y: 50, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 50, opacity: 0 }}
                    className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#080808] text-white px-6 py-4 rounded shadow-2xl flex items-center gap-8 z-40 border border-[#ccff00]/30"
                  >
                    <span className="text-xs font-semibold flex items-center gap-2">
                      <Info className="w-4 h-4 text-[#ccff00]" />
                      Unsaved strategy changes detected
                    </span>
                    <div className="flex gap-4">
                      <button 
                        onClick={handleDiscardConfig}
                        className="text-xs text-white/60 hover:text-white font-bold"
                      >
                        Discard
                      </button>
                      <button 
                        onClick={handleSaveConfig}
                        className="bg-[#ccff00] text-black font-bold px-4 py-2 rounded text-xs hover:bg-[#ccff00]/90 transition-colors"
                      >
                        Save Configuration
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {activeTab === "knowledge-base" && (
            <div className="space-y-8 animate-in fade-in duration-300">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-extrabold text-white tracking-tight">Knowledge Base Manager</h2>
                  <p className="text-white/40 text-xs font-semibold mt-1">
                    Upload, index, chunk and monitor your enterprise data sources for high-precision RAG context queries.
                  </p>
                </div>
                
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 w-4 h-4" />
                    <input 
                      type="text" 
                      placeholder="Search knowledge sources..."
                      value={kbSearchQuery}
                      onChange={(e) => setKbSearchQuery(e.target.value)}
                      className="pl-9 pr-4 py-2 bg-black/60 border border-white/10 rounded text-xs w-64 text-white placeholder-white/30 font-sans font-semibold outline-none focus:ring-1 focus:ring-[#ccff00]"
                    />
                  </div>
                  <button 
                    onClick={() => setIsNewDocOpen(true)}
                    className="bg-[#ccff00] text-black font-bold text-xs px-4 py-2.5 rounded hover:opacity-95 flex items-center gap-1.5 transition-all uppercase tracking-widest cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Add Document
                  </button>
                </div>
              </div>

              {/* Bento Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-[#080808] p-5 rounded soft-card flex flex-col justify-between h-32 border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Total Indexed Vectors</span>
                    <Layers className="w-4 h-4 text-[#ccff00]" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#ccff00]">1,248,502</div>
                  <div className="text-[10px] text-[#ccff00] font-mono font-bold flex items-center gap-0.5">
                    <TrendingUp className="w-3.5 h-3.5 text-[#ccff00]" /> +12.4% vs last week
                  </div>
                </div>

                <div className="bg-[#080808] p-5 rounded soft-card flex flex-col justify-between h-32 border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Active Data Sources</span>
                    <Server className="w-4 h-4 text-[#ccff00]" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-white">{sources.length} Sources</div>
                  <div className="text-[10px] text-white/40 font-semibold">{sources.filter(s => s.status === "Synced").length} synchronized</div>
                </div>

                <div className="bg-[#080808] p-5 rounded soft-card flex flex-col justify-between h-32 border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">Queries per Minute</span>
                    <Flame className="w-4 h-4 text-[#ccff00]" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-[#ccff00]">856 Q/m</div>
                  <div className="text-[10px] text-[#ccff00] font-mono font-bold flex items-center gap-0.5">
                    <TrendingUp className="w-3.5 h-3.5 text-[#ccff00]" /> Stability Optimal
                  </div>
                </div>

                <div className="bg-[#080808] p-5 rounded soft-card flex flex-col justify-between h-32 border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-white/40">System Storage Used</span>
                    <Database className="w-4 h-4 text-white/40" />
                  </div>
                  <div className="text-2xl font-bold font-mono text-white">4.2 TB</div>
                  <div className="w-full bg-white/10 h-1 rounded mt-1 overflow-hidden">
                    <div className="bg-[#ccff00] h-full" style={{ width: "72%" }}></div>
                  </div>
                </div>
              </div>

              {/* Index New Document Form Panel */}
              <AnimatePresence>
                {isNewDocOpen && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="bg-[#080808] p-6 rounded border border-white/10 shadow-md space-y-4 overflow-hidden"
                  >
                    <div className="flex justify-between items-center border-b border-white/10 pb-3">
                      <h3 className="font-display text-xs font-bold uppercase tracking-wider text-white flex items-center gap-2">
                        <FileText className="w-4 h-4 text-[#ccff00]" />
                        Index &amp; Chunk New Document (Ollama Embedding)
                      </h3>
                      <button
                        onClick={() => { setIsNewDocOpen(false); setPdfPageCount(null); }}
                        className="text-xs font-bold text-white/40 hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>

                    <form onSubmit={handleAddDocument} className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Document Name</label>
                          <input
                            type="text"
                            placeholder="e.g. Employee Handbook Q4.md"
                            value={newDocName}
                            onChange={(e) => setNewDocName(e.target.value)}
                            className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-sans text-white focus:bg-black focus:ring-1 focus:ring-[#ccff00] outline-none"
                          />
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Document Type</label>
                          <select
                            value={newDocType}
                            onChange={(e) => setNewDocType(e.target.value)}
                            className="p-2.5 bg-black/60 border border-white/10 rounded text-xs font-sans text-white focus:bg-black focus:ring-1 focus:ring-[#ccff00] outline-none"
                          >
                            <option>PDF Collection</option>
                            <option>Notion Webhook</option>
                            <option>G-Drive Archive</option>
                            <option>Text Document</option>
                            <option>API Connector</option>
                          </select>
                        </div>
                      </div>

                      {/* PDF Upload Zone */}
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Upload PDF File <span className="text-white/30">(optional — auto-extracts text)</span></label>
                        <label className={`flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed rounded cursor-pointer transition-all
                          ${isPdfParsing ? "border-[#ccff00]/40 bg-[#ccff00]/5" : "border-white/10 bg-black/40 hover:border-[#ccff00]/30 hover:bg-[#ccff00]/5"}`}>
                          <input
                            type="file"
                            accept=".pdf,application/pdf"
                            className="hidden"
                            disabled={isPdfParsing}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setIsPdfParsing(true);
                              setPdfPageCount(null);
                              try {
                                // Read file as base64
                                const base64 = await new Promise<string>((resolve, reject) => {
                                  const reader = new FileReader();
                                  reader.onload = () => {
                                    const result = reader.result as string;
                                    // Strip the data:application/pdf;base64, prefix
                                    resolve(result.split(",")[1]);
                                  };
                                  reader.onerror = reject;
                                  reader.readAsDataURL(file);
                                });
                                const res = await fetch("/api/parse-pdf", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ base64 }),
                                });
                                if (!res.ok) throw new Error("PDF parse failed");
                                const data = await res.json();
                                setNewDocContent(data.text.trim());
                                setPdfPageCount(data.pages);
                                // Auto-fill document name from filename if empty
                                if (!newDocName) setNewDocName(file.name.replace(/\.pdf$/i, ""));
                                setNewDocType("PDF Collection");
                                showToast(`PDF parsed: ${data.pages} pages, ${data.text.trim().split(/\s+/).length.toLocaleString()} words extracted.`, "success");
                              } catch (err) {
                                showToast("Failed to parse PDF. Is it a valid, non-scanned PDF?", "error");
                              } finally {
                                setIsPdfParsing(false);
                                // Reset file input so same file can be re-uploaded
                                e.target.value = "";
                              }
                            }}
                          />
                          {isPdfParsing ? (
                            <div className="flex flex-col items-center gap-2 text-[#ccff00]">
                              <RefreshCw className="w-6 h-6 animate-spin" />
                              <span className="text-xs font-mono font-bold">Extracting PDF text...</span>
                            </div>
                          ) : pdfPageCount !== null ? (
                            <div className="flex flex-col items-center gap-1 text-[#ccff00]">
                              <CheckCircle className="w-6 h-6" />
                              <span className="text-xs font-mono font-bold">{pdfPageCount} pages extracted — click to replace</span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-1 text-white/40">
                              <FileText className="w-6 h-6" />
                              <span className="text-xs font-mono">Click to upload a PDF file</span>
                              <span className="text-[10px] text-white/25">Text-based PDFs only · max 50MB</span>
                            </div>
                          )}
                        </label>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Document Content Text</label>
                        <p className="text-[10px] text-white/40 mb-1 leading-relaxed">
                          This content will be divided into chunks of <span className="font-bold text-[#ccff00] font-mono">{pendingConfig?.chunkSize || 512} tokens</span> with <span className="font-bold text-[#ccff00] font-mono">{pendingConfig?.chunkOverlap || 15}% overlap</span> using the <span className="font-bold text-[#ccff00] font-mono">{pendingConfig?.separationStrategy || "Semantic"}</span> strategy, then mapped to actual embedding vectors.
                        </p>
                        <textarea
                          rows={6}
                          placeholder="Paste text here, or upload a PDF above to auto-fill..."
                          value={newDocContent}
                          onChange={(e) => setNewDocContent(e.target.value)}
                          className="p-3 bg-black/60 border border-white/10 rounded text-xs font-mono text-white focus:bg-black focus:ring-1 focus:ring-[#ccff00] outline-none"
                        />
                      </div>

                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => { setIsNewDocOpen(false); setPdfPageCount(null); }}
                          className="px-4 py-2 border border-white/10 text-white/60 font-semibold text-xs rounded hover:bg-white/5"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isLoading || isPdfParsing}
                          className="px-5 py-2 bg-[#ccff00] text-black font-bold text-xs rounded hover:opacity-90 flex items-center gap-1.5 transition-all uppercase tracking-wider cursor-pointer disabled:opacity-50"
                        >
                          {isLoading ? "Running Embedding & Chunking..." : "Index & Sync document"}
                        </button>
                      </div>
                    </form>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Data Sources Table Card */}
              <div className="bg-[#080808] rounded border border-white/10 overflow-hidden">
                <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                  <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">Data Sources <span className="text-xs font-normal text-white/40 ml-2">(Alpha-Team Environment)</span></h3>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-white/5 border-b border-white/10">
                      <tr>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">SOURCE NAME</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">TYPE</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">STATUS / PROGRESS</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">LAST SYNC</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">VECTORS</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest">OWNER</th>
                        <th className="px-6 py-3 text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest text-right">ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {filteredSources.map((doc) => {
                        const progress = indexingProgress[doc.id];
                        const isIndexing = !!progress || doc.status === "Syncing...";
                        const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
                        return (
                        <tr key={doc.id} className="hover:bg-white/[0.02] transition-colors group">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00] ${isIndexing ? "animate-pulse" : ""}`}>
                                <FileText className="w-4 h-4" />
                              </div>
                              <div>
                                <span className="font-semibold text-xs text-white block">{doc.name}</span>
                                <span className="text-[10px] text-white/40 font-mono block mt-0.5">{doc.id}</span>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="px-2 py-0.5 rounded bg-white/10 text-white/80 text-[10px] font-mono font-bold uppercase">
                              {doc.type}
                            </span>
                          </td>
                          <td className="px-6 py-4 min-w-[160px]">
                            {isIndexing && progress ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono text-amber-400 font-bold">Embedding…</span>
                                  <span className="text-[10px] font-mono text-amber-400 font-bold">{progress.done}/{progress.total}</span>
                                </div>
                                <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                                  <div
                                    className="bg-amber-400 h-full rounded-full transition-all duration-300"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className="text-[9px] font-mono text-white/30">{pct}% complete</span>
                              </div>
                            ) : (
                              <div className={`flex items-center gap-1.5 text-xs font-mono font-semibold ${
                                doc.status === "Synced" ? "text-[#ccff00]" :
                                doc.status === "Syncing..." ? "text-amber-500 animate-pulse" :
                                doc.status === "Paused" ? "text-white/40" : "text-red-500"
                              }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                  doc.status === "Synced" ? "bg-[#ccff00]" :
                                  doc.status === "Syncing..." ? "bg-amber-500" :
                                  doc.status === "Paused" ? "bg-white/40" : "bg-red-500"
                                }`}></span>
                                {doc.status}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-xs text-white/60 font-mono">{doc.lastSync}</td>
                          <td className="px-6 py-4 text-xs font-mono text-[#ccff00] font-bold">{doc.vectorsCount.toLocaleString()}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              {doc.ownerAvatar ? (
                                <img
                                  src={doc.ownerAvatar}
                                  alt="Owner Avatar"
                                  referrerPolicy="no-referrer"
                                  className="w-6 h-6 rounded-full object-cover border border-white/10"
                                />
                              ) : (
                                <div className="w-6 h-6 rounded-full bg-white/10 border border-white/10"></div>
                              )}
                              <span className="text-xs text-white/80 font-semibold">{doc.owner}</span>
                            </div>
                          </td>
                          {/* Actions */}
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => handleReindex(doc.id)}
                                disabled={isIndexing}
                                title="Re-chunk & Re-embed"
                                className="p-1.5 rounded hover:bg-[#ccff00]/10 text-white/40 hover:text-[#ccff00] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${isIndexing ? "animate-spin" : ""}`} />
                              </button>
                              <button
                                onClick={() => handleDeleteSource(doc.id)}
                                disabled={isIndexing}
                                title="Delete document"
                                className="p-1.5 rounded hover:bg-red-500/10 text-white/40 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              >
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

                <div className="px-6 py-3 bg-transparent border-t border-white/10 flex items-center justify-between">
                  <span className="text-xs text-white/40 font-semibold">Showing 1-{filteredSources.length} of {sources.length} results</span>
                  <div className="flex gap-1.5">
                    <button className="p-1 border border-white/10 rounded disabled:opacity-30 cursor-pointer text-white hover:bg-white/5" disabled>
                      <ChevronLeft className="w-4 h-4 text-white/40" />
                    </button>
                    <button className="p-1 border border-white/10 rounded disabled:opacity-30 cursor-pointer text-white hover:bg-white/5" disabled>
                      <ChevronRight className="w-4 h-4 text-white/40" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "admin" && (
            <div className="space-y-8 animate-in fade-in duration-300">
              <div className="mb-4">
                <h2 className="font-display text-2xl font-extrabold text-white mb-1">Global Admin Configuration</h2>
                <p className="text-white/40 text-xs font-semibold">
                  Manage enterprise-wide security parameters, user hierarchies, active SSO policies, and AI embedding foundation models.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* User Management */}
                <div className="lg:col-span-8 bg-[#080808] rounded p-6 flex flex-col justify-between border border-white/10 soft-card">
                  <div className="space-y-6">
                    <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-2">
                      <div className="flex items-center gap-3">
                        <Users className="w-6 h-6 text-[#ccff00]" />
                        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">User Workspace Management</h3>
                      </div>
                      <button 
                        onClick={() => setIsAddUserOpen(true)}
                        className="text-xs text-[#ccff00] font-mono uppercase tracking-wider font-bold hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <UserPlus className="w-4 h-4" /> Add Collaborator
                      </button>
                    </div>

                    {/* Add User form */}
                    <AnimatePresence>
                      {isAddUserOpen && (
                        <motion.form 
                          onSubmit={handleAddUser}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="bg-black/60 p-4 rounded space-y-3 overflow-hidden border border-white/10"
                        >
                          <h4 className="text-xs font-bold text-white uppercase tracking-wider">Add New Collaborator to Alpha-Team</h4>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <input 
                              type="text" 
                              placeholder="Name" 
                              required
                              value={newUserName}
                              onChange={(e) => setNewUserName(e.target.value)}
                              className="p-2 bg-black border border-white/10 rounded text-xs text-white outline-none focus:ring-1 focus:ring-[#ccff00] font-semibold"
                            />
                            <input 
                              type="email" 
                              placeholder="Email" 
                              required
                              value={newUserEmail}
                              onChange={(e) => setNewUserEmail(e.target.value)}
                              className="p-2 bg-black border border-white/10 rounded text-xs text-white outline-none focus:ring-1 focus:ring-[#ccff00] font-mono"
                            />
                            <select 
                              value={newUserRole}
                              onChange={(e) => setNewUserRole(e.target.value)}
                              className="p-2 bg-black border border-white/10 rounded text-xs text-white/80 outline-none font-semibold"
                            >
                              <option>Super Admin</option>
                              <option>Developer</option>
                              <option>Viewer</option>
                            </select>
                          </div>
                          <div className="flex justify-end gap-2 text-xs">
                            <button 
                              type="button" 
                              onClick={() => setIsAddUserOpen(false)}
                              className="px-3 py-1 bg-white/5 border border-white/10 rounded text-white/80 hover:bg-white/10 font-bold"
                            >
                              Cancel
                            </button>
                            <button 
                              type="submit" 
                              className="px-3 py-1 bg-[#ccff00] text-black rounded hover:opacity-90 font-bold cursor-pointer"
                            >
                              Add
                            </button>
                          </div>
                        </motion.form>
                      )}
                    </AnimatePresence>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="bg-white/5 text-white/40 border-b border-white/10">
                            <th className="px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest">User</th>
                            <th className="px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest">Role</th>
                            <th className="px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest">Last Login</th>
                            <th className="px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/10">
                          {users.map((u) => (
                            <tr key={u.id} className="hover:bg-white/[0.01] transition-colors">
                              <td className="px-4 py-3 flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center font-bold text-xs text-[#ccff00] border border-white/15">
                                  {u.name.split(" ").map((n: string) => n[0]).join("")}
                                </div>
                                <div>
                                  <div className="text-xs font-bold text-white">{u.name}</div>
                                  <div className="text-[10px] text-white/40 font-mono">{u.email}</div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${
                                  u.role === "Super Admin" ? "bg-[#ccff00]/10 text-[#ccff00] border-[#ccff00]/20" :
                                  u.role === "Developer" ? "bg-white/10 text-white/80 border-white/10" :
                                  "bg-white/5 text-white/40 border-white/5"
                                }`}>
                                  {u.role}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs text-white/60 font-mono">{u.lastLogin}</td>
                              <td className="px-4 py-3 text-right">
                                <button 
                                  onClick={() => handleDeleteUser(u.id)}
                                  className="p-1 hover:bg-red-500/10 text-white/40 hover:text-red-500 rounded transition-colors cursor-pointer"
                                  title="Remove User"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Role Based Access & Alerts */}
                <div className="lg:col-span-4 flex flex-col gap-8">
                  <section className="bg-[#080808] p-6 rounded border border-white/10 flex flex-col justify-between soft-card">
                    <div>
                      <div className="flex items-center gap-3 border-b border-white/10 pb-4 mb-4">
                        <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                          <Key className="w-5 h-5" />
                        </div>
                        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Access Control</h3>
                      </div>

                      <div className="space-y-4">
                        <div className="p-4 rounded bg-black/60 border border-white/10">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs font-bold text-white">SSO Enforcement Policy</span>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={pendingConfig?.ssoEnabled ?? true} 
                                onChange={(e) => handleToggleSSO(e.target.checked)}
                                className="sr-only peer" 
                              />
                              <div className="w-9 h-5 bg-white/10 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-black after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#ccff00]"></div>
                            </label>
                          </div>
                          <p className="text-[10px] text-white/40 leading-relaxed font-medium">Require Microsoft Entra / Okta Single Sign-On validation for all organization workspace contributors.</p>
                        </div>

                        <div className="p-4 rounded border border-white/10 bg-black/40">
                          <h4 className="text-xs font-bold mb-3 text-white uppercase tracking-wider">Role Presets</h4>
                          <div className="flex flex-wrap gap-1.5">
                            <span className="px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] font-mono font-bold text-white/80">Owner</span>
                            <span className="px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] font-mono font-bold text-white/80">Editor</span>
                            <span className="px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] font-mono font-bold text-white/80">Compliance</span>
                            <span className="px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] font-mono font-bold text-white/80">Viewer</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 pt-4 border-t border-white/10">
                      <div className="bg-red-500/10 p-3.5 border border-red-500/20 rounded flex gap-3">
                        <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 animate-pulse" />
                        <div>
                          <p className="text-xs font-bold text-red-500">Security Alert</p>
                          <p className="text-[10px] text-white/60 mt-1">3 users have inactive 2FA credentials. <a href="#" className="underline font-bold text-[#ccff00] hover:opacity-80">Remind team now</a></p>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              {/* Providers configuration */}
              <section className="bg-[#080808] p-6 rounded border border-white/10 soft-card">
                <div className="flex items-center gap-3 border-b border-white/10 pb-4 mb-6">
                  <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[#ccff00]">
                    <Network className="w-5 h-5" />
                  </div>
                  <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Global Embedding &amp; AI Foundation Providers</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* OpenAI Provider */}
                  <div className="p-5 rounded border-2 border-[#ccff00] bg-[#ccff00]/5 flex flex-col gap-4 relative overflow-hidden">
                    <div className="absolute -right-3 -top-3 w-12 h-12 bg-[#ccff00]/10 rounded-full flex items-center justify-center">
                      <CheckCircle className="w-5 h-5 text-[#ccff00]" />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-white/5 rounded border border-white/10 flex items-center justify-center font-bold font-mono text-[#ccff00]">OA</div>
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider">OpenAI Integration</h4>
                        <p className="text-[10px] text-white/40 font-semibold">Active Embedding Provider</p>
                      </div>
                    </div>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between font-semibold">
                        <span className="text-white/40">Default Model</span>
                        <span className="font-mono text-white">text-embedding-3-small</span>
                      </div>
                      <div className="flex justify-between font-semibold">
                        <span className="text-white/40">Endpoint Status</span>
                        <span className="text-[#ccff00] font-mono font-bold">Active Operational</span>
                      </div>
                    </div>
                    <button 
                      onClick={() => showToast("Configure OpenAI parameters in Secrets Panel.", "info")}
                      className="mt-2 w-full py-2 bg-white text-black rounded text-xs font-bold hover:bg-white/90 cursor-pointer transition-all uppercase tracking-wider"
                    >
                      Configure API
                    </button>
                  </div>

                  {/* Azure AI Search */}
                  <div className="p-5 rounded border border-white/10 bg-black/40 flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-white/5 rounded border border-white/10 flex items-center justify-center font-bold font-mono text-white/60">AZ</div>
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider">Azure AI Search</h4>
                        <p className="text-[10px] text-white/40 font-semibold">Standby Backup Provider</p>
                      </div>
                    </div>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between font-semibold">
                        <span className="text-white/40">Fallback Integration</span>
                        <span className="font-mono text-white">Azure Vector Indexing</span>
                      </div>
                      <div className="flex justify-between font-semibold">
                        <span className="text-white/40">Automatic Sync Mode</span>
                        <span className="font-mono text-white">Automated Pool</span>
                      </div>
                    </div>
                    <button 
                      onClick={() => showToast("Backup destination details configured.", "info")}
                      className="mt-2 w-full py-2 border border-white/15 text-white/60 hover:text-white rounded text-xs font-bold hover:bg-white/5 cursor-pointer transition-all"
                    >
                      Manage Connection
                    </button>
                  </div>

                  {/* Custom Provider Placeholder */}
                  <div className="p-5 rounded border border-dashed border-white/10 flex flex-col items-center justify-center gap-3 text-center cursor-pointer hover:bg-white/[0.01] transition-all">
                    <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-[#ccff00]">
                      <Plus className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider">Add Custom Provider</h4>
                      <p className="text-[10px] text-white/40 mt-1 font-semibold">Integrate Cohere, Anthropic, or proprietary models easily.</p>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeTab === "dashboard" && (
            <div className="space-y-8 animate-in fade-in duration-300">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-extrabold text-white tracking-tight mb-1">System Overview Analytics</h2>
                  <p className="text-white/40 text-xs font-semibold">
                    Real-time performance metrics, ground truth retrieval accuracy, and query logs across clusters.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex -space-x-2">
                    <img 
                      className="w-8 h-8 rounded-full border-2 border-black object-cover" 
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuCONoDlCFUX2W4J619dAsh5Xf7gEgSAmqmMZSCEROMX7CtWYIQprJ3MpG599_KCx9IrnjrxGOK7GKYuQ-mHqgy7-RaB0s1NfEKQ4RZGux4KIZAJsfLBqvDM2SQODQD5pcTIfpubaXDlmNZM25Lz9zabfGV5FC7kWeblY0OYJ9Njbkv7Jqqu-3l-fHJw7ozpAYf5UKmBXG-Mlvl_cTM1qFmnsqBbluiLH8La3rU0rsg4FW9Ct8tyHqpo" 
                      alt="Data Scientist Avatar" 
                      referrerPolicy="no-referrer"
                    />
                    <img 
                      className="w-8 h-8 rounded-full border-2 border-black object-cover" 
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuAo36KgbQUtNLGW1CMOCwfDZOu5T3dR0OXFFMvxYHVvmEbQBmXvkVa-gCK3KYetpwAN331cRcybzS9bQKn0ZrZEyCBOkd0_RKnpG87DYwWUooWiYUuTyF0oW8_5iSg-Vjl9x7cIySVyEtNYMZJ0DhGmfE9Pc6B0VFBhYW03aAUBkLktFQuCrFV6SHTZWmZppR2R-ZQa7yTRASbl2dXu_cEBTMhTOGDJxqCIEYjnFj_zUrFArinD7PIr" 
                      alt="Engineer Avatar" 
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <span className="text-xs font-semibold text-white/40">Team Alpha-12</span>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* System Health */}
                <div className="bg-[#080808] p-6 rounded soft-card flex flex-col justify-between h-44 border border-white/10">
                  <div className="flex justify-between items-start">
                    <div className="p-2 bg-white/5 text-[#ccff00] rounded">
                      <CheckCircle className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-mono font-bold text-[#ccff00] bg-[#ccff00]/10 border border-[#ccff00]/20 px-2 py-0.5 rounded flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-[#ccff00] rounded-full animate-ping"></span>
                      HEALTHY
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/40 font-mono uppercase tracking-wider block">Overall System Health</span>
                    <span className="text-3xl font-bold font-mono text-[#ccff00] mt-1 block">99.9%</span>
                  </div>
                  <p className="text-xs text-white/40 font-semibold">Uptime maintained across 14 clusters</p>
                </div>

                {/* Mean Latency */}
                <div className="bg-[#080808] p-6 rounded soft-card flex flex-col justify-between h-44 border border-white/10">
                  <div className="flex justify-between items-start">
                    <div className="p-2 bg-white/5 text-[#ccff00] rounded">
                      <Clock className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-mono font-bold text-white/80 bg-white/10 px-2 py-0.5 rounded">Avg 240ms</span>
                  </div>
                  
                  {/* Fake micro Latency chart */}
                  <div className="flex items-end gap-1.5 h-8 px-1">
                    <div className="w-full bg-white/5 h-4 rounded-sm"></div>
                    <div className="w-full bg-white/10 h-6 rounded-sm"></div>
                    <div className="w-full bg-white/10 h-8 rounded-sm"></div>
                    <div className="w-full bg-white/15 h-5 rounded-sm"></div>
                    <div className="w-full bg-[#ccff00]/40 h-10 rounded-sm"></div>
                    <div className="w-full bg-[#ccff00] h-12 rounded-sm"></div>
                  </div>

                  <p className="text-xs text-[#ccff00] font-mono font-bold flex items-center gap-0.5">
                    <TrendingDown className="w-3.5 h-3.5" /> -12ms from last hour window
                  </p>
                </div>

                {/* Retrieval Accuracy */}
                <div className="bg-[#080808] p-6 rounded soft-card flex flex-col justify-between h-44 border border-white/10">
                  <div className="flex justify-between items-start">
                    <div className="p-2 bg-white/5 text-[#ccff00] rounded">
                      <Award className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-mono font-bold text-white/60">Target 95%</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-white/40 font-mono uppercase tracking-wider block">Retrieval Faithfulness</span>
                    <span className="text-3xl font-bold font-mono text-white mt-1 block">94.2%</span>
                    <div className="w-full bg-white/10 h-1 rounded mt-2 overflow-hidden">
                      <div className="bg-[#ccff00] h-full" style={{ width: "94%" }}></div>
                    </div>
                  </div>
                  <p className="text-xs text-white/40 font-medium">Based on continuous ground truth verification sets</p>
                </div>
              </div>

              {/* Vector Storage & Logs Bento Section */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Pipelines Table */}
                <div className="lg:col-span-2 bg-[#080808] rounded border border-white/10 overflow-hidden">
                  <div className="p-5 border-b border-white/10 flex justify-between items-center">
                    <h4 className="font-display text-xs font-bold uppercase tracking-wider text-white">Active User Pipelines</h4>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={openNewPipeline}
                        className="text-xs text-[#ccff00] font-mono uppercase tracking-wider font-bold flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" /> New
                      </button>
                      <button
                        onClick={() => setActiveTab("playground")}
                        className="text-xs text-white/40 font-mono uppercase tracking-wider font-bold flex items-center gap-1 hover:text-white cursor-pointer"
                      >
                        Run Test <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-white/5 text-[10px] font-mono font-bold text-white/40 border-b border-white/10 uppercase tracking-widest">
                          <th className="px-6 py-3 font-semibold">PIPELINE</th>
                          <th className="px-6 py-3 font-semibold">MODEL</th>
                          <th className="px-6 py-3 font-semibold">LATENCY</th>
                          <th className="px-6 py-3 font-semibold">FAITHFULNESS</th>
                          <th className="px-6 py-3 font-semibold">ACTIONS</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10 text-white">
                        {pipelines.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-6 py-8 text-center text-xs text-white/30 font-mono">
                              No pipelines configured. Click <span className="text-[#ccff00]">+ New</span> to create one.
                            </td>
                          </tr>
                        ) : pipelines.map(p => {
                          const hasStats = p.stats && p.stats.queryCount > 0;
                          const latency = hasStats ? `${Math.round(p.stats.avgLatencyMs)}ms` : "--";
                          const faith = hasStats ? `${(p.stats.avgFaithfulness * 100).toFixed(1)}%` : "--";
                          const statColor = p.enabled ? "text-[#ccff00]" : "text-white/30";
                          return (
                            <tr key={p.id} className="hover:bg-white/[0.01] transition-colors">
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.enabled ? "bg-[#ccff00] animate-pulse" : "bg-white/20"}`}></span>
                                  <div>
                                    <p className={`text-xs font-bold ${p.enabled ? "text-white" : "text-white/40"}`}>{p.name}</p>
                                    <p className="text-[10px] text-white/40 font-medium truncate max-w-[160px]">{p.description || (p.enabled ? "Active" : "Disabled")}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`text-xs font-mono bg-white/10 px-2 py-0.5 rounded font-semibold border border-white/10 ${p.enabled ? "text-white/80" : "text-white/30"}`}>
                                  {p.generationModel}
                                </span>
                              </td>
                              <td className={`px-6 py-4 text-xs font-mono font-semibold ${statColor}`}>{latency}</td>
                              <td className={`px-6 py-4 text-xs font-mono font-bold ${statColor}`}>{faith}</td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => handleTogglePipelineEnabled(p)}
                                    title={p.enabled ? "Disable pipeline" : "Enable pipeline"}
                                    className="text-white/30 hover:text-[#ccff00] transition-colors cursor-pointer"
                                  >
                                    {p.enabled ? <ToggleRight className="w-4 h-4 text-[#ccff00]" /> : <ToggleLeft className="w-4 h-4" />}
                                  </button>
                                  <button
                                    onClick={() => openEditPipeline(p)}
                                    title="Edit pipeline"
                                    className="text-white/30 hover:text-white transition-colors cursor-pointer"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDeletePipeline(p.id)}
                                    title="Delete pipeline"
                                    className="text-white/30 hover:text-red-400 transition-colors cursor-pointer"
                                  >
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

                {/* Storage Distribution */}
                <div className="bg-[#080808] p-5 rounded border border-white/10 flex flex-col justify-between soft-card">
                  <h4 className="text-[10px] font-mono font-bold text-white/40 uppercase tracking-widest mb-2">Vector Storage Distribution</h4>
                  <div className="relative w-full aspect-square max-h-36 mx-auto flex items-center justify-center">
                    <div className="absolute inset-0 border-[8px] border-white/5 rounded-full"></div>
                    <div className="absolute inset-0 border-[8px] border-[#ccff00] rounded-full" style={{ clipPath: "polygon(50% 50%, 50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%)" }}></div>
                    <div className="text-center">
                      <p className="text-2xl font-bold font-mono text-[#ccff00] leading-none">82%</p>
                      <p className="text-[9px] text-white/40 font-mono uppercase mt-1">Capacity</p>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-white/60"><span className="w-1.5 h-1.5 rounded-full bg-[#ccff00]"></span> Pinecone Global</span>
                      <span className="font-mono font-bold text-white">12.4M vectors</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-white/60"><span className="w-1.5 h-1.5 rounded-full bg-white/10 border border-white/20"></span> Local Weaviate</span>
                      <span className="font-mono font-bold text-white">2.1M vectors</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Recent Query Logs Listing */}
              <section className="bg-[#080808] rounded border border-white/10 p-6">
                <h4 className="font-display text-xs font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#ccff00]" />
                  Recent System Retrieval &amp; Query Logs
                </h4>
                
                <div className="space-y-4">
                  {logs.map((log) => (
                    <div 
                      key={log.id} 
                      className="border border-white/10 rounded overflow-hidden transition-all"
                    >
                      {/* Log Summary Row */}
                      <div 
                        onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                        className="p-4 bg-black/40 hover:bg-white/[0.02] flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer"
                      >
                        <div className="flex items-center gap-4">
                          <span className="font-mono text-xs text-white/40">{log.timestamp}</span>
                          <div>
                            <span className="text-[10px] font-mono font-bold text-[#ccff00] uppercase bg-[#ccff00]/10 border border-[#ccff00]/20 px-1.5 py-0.5 rounded mr-2">
                              {log.pipeline}
                            </span>
                            <span className="font-semibold text-xs text-white">{log.query}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 justify-between md:justify-end">
                          <span className="text-[10px] px-2.5 py-1 rounded font-mono font-bold uppercase bg-white/5 text-white/80 border border-white/10">
                            {log.faithfulnessScore}% Faithfulness
                          </span>
                          <span className="text-xs font-mono text-[#ccff00] font-bold">{log.latencyMs}ms</span>
                          <ChevronRight className={`w-4 h-4 text-white/40 transition-transform ${expandedLogId === log.id ? "rotate-90" : ""}`} />
                        </div>
                      </div>

                      {/* Log Expanded Details */}
                      {expandedLogId === log.id && (
                        <div className="p-5 border-t border-white/10 bg-black/60 space-y-4 text-xs text-white/80">
                          {/* Generated Response */}
                          <div>
                            <h5 className="font-mono font-bold text-[#ccff00] mb-2 uppercase tracking-wider text-[10px]">Grounded Generation Answer</h5>
                            <div className="p-4 bg-black/40 border border-white/10 rounded text-white font-sans leading-relaxed">
                              <SafeRAGResponseRenderer text={log.answer} />
                            </div>
                          </div>

                          {/* Retrieved chunks list */}
                          <div>
                            <h5 className="font-mono font-bold text-white/40 mb-2 uppercase tracking-wider text-[10px]">Retrieved Context Chunks (Similarity Rank)</h5>
                            <div className="space-y-2">
                              {log.retrievedChunks && log.retrievedChunks.length > 0 ? (
                                log.retrievedChunks.map((chk, i) => (
                                  <div key={i} className="p-3 border border-dashed border-white/10 bg-black/40 rounded flex justify-between items-start gap-4">
                                    <div className="flex-1">
                                      <span className="bg-white/5 text-[#ccff00] px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase mr-2 border border-white/10">
                                        Chunk {i+1}: {chk.sourceName}
                                      </span>
                                      {/* Chunks themselves might contain image hotlinks, render them safely as well! */}
                                      <div className="mt-2.5 text-white/90">
                                        <SafeRAGResponseRenderer text={chk.text} />
                                      </div>
                                    </div>
                                    <span className="text-[10px] font-mono bg-[#ccff00]/10 text-[#ccff00] border border-[#ccff00]/20 px-2 py-0.5 rounded font-bold whitespace-nowrap">
                                      Similarity: {chk.score}
                                    </span>
                                  </div>
                                ))
                              ) : (
                                <p className="text-white/40 italic">No text chunks were retrieved for this log.</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {activeTab === "playground" && (
            <div className="space-y-8 animate-in fade-in duration-300">
              <div className="mb-4">
                <h2 className="font-display text-2xl font-extrabold text-white tracking-tight mb-1">RAG Playground &amp; Pipeline Inspection</h2>
                <p className="text-white/40 text-xs font-semibold">
                  Test your document retrieval corpus. Enter any search query, run local similarity evaluation, and visualize the prompt-grounding chain.
                </p>
              </div>

              {/* Search Query Submit Box */}
              <div className="bg-[#080808] p-6 rounded border border-white/10">
                <form onSubmit={handlePlaygroundQuery} className="space-y-4">
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Ask a Question Grounded in Your Documents</label>
                      <input 
                        type="text" 
                        placeholder="e.g. Show me the distribution of our database cluster diagram"
                        value={playgroundQuery}
                        onChange={(e) => setPlaygroundQuery(e.target.value)}
                        className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-sans font-semibold text-white outline-none focus:bg-black focus:ring-1 focus:ring-[#ccff00]"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5 w-full md:w-64">
                      <label className="text-[10px] font-mono uppercase tracking-wider text-white/60">Select Retrieval Pipeline</label>
                      <select 
                        value={playgroundPipeline}
                        onChange={(e) => setPlaygroundPipeline(e.target.value)}
                        className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-sans font-semibold text-white outline-none focus:bg-black focus:ring-1 focus:ring-[#ccff00] cursor-pointer"
                      >
                        {pipelines.filter(p => p.enabled).map(p => (
                          <option key={p.id} value={p.name}>{p.name}</option>
                        ))}
                        {pipelines.filter(p => p.enabled).length === 0 && (
                          <option disabled>No enabled pipelines</option>
                        )}
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-between items-center border-t border-white/10 pt-4">
                    <span className="text-[10px] text-white/40 font-semibold">
                      Using <span className="font-bold text-[#ccff00]">gemini-3.5-flash</span> with automated ground truth metrics.
                    </span>
                    <button 
                      type="submit"
                      disabled={isQuerying}
                      className="px-6 py-2.5 bg-[#ccff00] text-black text-xs font-bold rounded hover:opacity-95 flex items-center gap-2 transition-all uppercase tracking-widest cursor-pointer"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      {isQuerying ? "Retrieving & Generating..." : "Execute RAG Pipeline"}
                    </button>
                  </div>
                </form>
              </div>

              {/* Visual Pipeline Grounding Flow Chart */}
              {playgroundResult ? (
                <div className="space-y-8 animate-in slide-in-from-bottom duration-500">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Metrics Block */}
                    <div className="bg-white/5 border border-white/10 p-5 rounded flex items-center gap-4">
                      <Award className="w-8 h-8 text-[#ccff00] flex-shrink-0" />
                      <div>
                        <h4 className="text-[10px] font-mono uppercase tracking-wider text-white/40">Faithfulness Rating</h4>
                        <p className="text-2xl font-bold font-mono text-[#ccff00]">{playgroundResult.faithfulnessScore}%</p>
                        <p className="text-[10px] text-white/40 mt-1">The generated answer is strictly supported by context chunks.</p>
                      </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 p-5 rounded flex items-center gap-4">
                      <Network className="w-8 h-8 text-[#ccff00] flex-shrink-0" />
                      <div>
                        <h4 className="text-[10px] font-mono uppercase tracking-wider text-white/40">Relevance Score</h4>
                        <p className="text-2xl font-bold font-mono text-white">{playgroundResult.relevanceScore}%</p>
                        <p className="text-[10px] text-white/40 mt-1">Retrieved document nodes match the prompt semantics.</p>
                      </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 p-5 rounded flex items-center gap-4">
                      <Clock className="w-8 h-8 text-white/40 flex-shrink-0" />
                      <div>
                        <h4 className="text-[10px] font-mono uppercase tracking-wider text-white/40">Execution Latency</h4>
                        <p className="text-2xl font-bold font-mono text-[#ccff00]">{playgroundResult.latencyMs}ms</p>
                        <p className="text-[10px] text-white/40 mt-1">End-to-end vector indexing and prompt lookup speed.</p>
                      </div>
                    </div>
                  </div>

                  {/* Flow Diagram */}
                  <div className="relative border-l border-white/10 ml-4 pl-8 space-y-8">
                    {/* Step 1: Retrieval */}
                    <div className="relative">
                      <div className="absolute -left-[41px] top-0 w-6 h-6 bg-[#ccff00] text-black rounded-full flex items-center justify-center font-bold text-xs font-mono">
                        1
                      </div>
                      <div className="bg-[#080808] p-6 rounded border border-white/10 space-y-4">
                        <div>
                          <h4 className="font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2 text-[#ccff00]">
                            <Layers className="w-4 h-4" />
                            Step 1: Context Retrieval (Cosine Similarity)
                          </h4>
                          <p className="text-white/40 text-xs mt-1.5 leading-relaxed">
                            The query embedding vector was searched against active indices. The following top-matching text nodes were selected:
                          </p>
                        </div>

                        <div className="space-y-3">
                          {playgroundResult.retrievedChunks.map((chunk, idx) => (
                            <div key={idx} className="p-4 bg-black/40 border border-white/10 rounded">
                              <div className="flex justify-between items-center mb-2">
                                <span className="bg-white/10 text-white px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase border border-white/10">
                                  {chunk.sourceName}
                                </span>
                                <span className="text-[10px] font-mono text-[#ccff00] font-bold bg-[#ccff00]/10 border border-[#ccff00]/20 px-2 py-0.5 rounded">
                                  Score: {chunk.score}
                                </span>
                              </div>
                              <div className="text-xs text-white/80 leading-relaxed font-sans">
                                <SafeRAGResponseRenderer text={chunk.text} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Step 2: Generation */}
                    <div className="relative">
                      <div className="absolute -left-[41px] top-0 w-6 h-6 bg-[#ccff00] text-black rounded-full flex items-center justify-center font-bold text-xs font-mono">
                        2
                      </div>
                      <div className="bg-[#080808] p-6 rounded border border-white/10 space-y-4">
                        <h4 className="font-display text-xs font-bold uppercase tracking-wider flex items-center gap-2 text-[#ccff00]">
                          <Network className="w-4 h-4" />
                          Step 2: Context-Grounded Prompt Generation
                        </h4>
                        <p className="text-white/40 text-xs leading-relaxed">
                          The context chunks were assembled securely into a structured system template and passed to the model. Here is the response:
                        </p>
                        <div className="p-4 bg-black/60 text-white rounded border-l-2 border-[#ccff00] leading-relaxed text-xs font-sans">
                          <SafeRAGResponseRenderer text={playgroundResult.answer} isDark={true} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                isQuerying ? (
                  <div className="bg-[#080808] p-12 rounded border border-white/10 text-center space-y-4 flex flex-col items-center justify-center">
                    <RefreshCw className="w-10 h-10 text-[#ccff00] animate-spin" />
                    <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">Assembling Retrieval Context Node...</h3>
                    <p className="text-white/40 text-xs max-w-sm">
                      Executing server-side document query vector comparisons and calling Gemini-3.5-Flash to execute evaluation and response generation.
                    </p>
                  </div>
                ) : (
                  <div className="bg-[#080808] p-12 rounded border border-white/10 text-center space-y-3">
                    <Flame className="w-10 h-10 text-white/20 mx-auto" />
                    <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">Ready to run retrieval pipeline</h3>
                    <p className="text-white/40 text-xs max-w-md mx-auto">
                      Enter any query in the field above to run cosine vector similarities, parse context document chunks, and review prompt grounding chain evaluations.
                    </p>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </main>

      {/* Mobile Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-[#080808] border-t border-white/10 flex justify-around items-center px-4 z-40">
        <button 
          onClick={() => setActiveTab("dashboard")}
          className={`flex flex-col items-center gap-1 ${activeTab === "dashboard" ? "text-[#ccff00]" : "text-white/40"}`}
        >
          <LayoutDashboard className="w-5 h-5" />
          <span className="text-[9px] font-mono font-bold uppercase">Home</span>
        </button>
        <button 
          onClick={() => setActiveTab("workspace")}
          className={`flex flex-col items-center gap-1 ${activeTab === "workspace" ? "text-[#ccff00]" : "text-white/40"}`}
        >
          <Sliders className="w-5 h-5" />
          <span className="text-[9px] font-mono font-bold uppercase">Strategy</span>
        </button>
        <button 
          onClick={() => setActiveTab("knowledge-base")}
          className={`flex flex-col items-center gap-1 ${activeTab === "knowledge-base" ? "text-[#ccff00]" : "text-white/40"}`}
        >
          <Database className="w-5 h-5" />
          <span className="text-[9px] font-mono font-bold uppercase">KB</span>
        </button>
        <button 
          onClick={() => setActiveTab("admin")}
          className={`flex flex-col items-center gap-1 ${activeTab === "admin" ? "text-[#ccff00]" : "text-white/40"}`}
        >
          <Shield className="w-5 h-5" />
          <span className="text-[9px] font-mono font-bold uppercase">Admin</span>
        </button>
        <button 
          onClick={() => setActiveTab("playground")}
          className={`flex flex-col items-center gap-1 ${activeTab === "playground" ? "text-[#ccff00]" : "text-white/40"}`}
        >
          <Flame className="w-5 h-5 text-current" />
          <span className="text-[9px] font-mono font-bold uppercase">RAG</span>
        </button>
      </nav>

      {/* ── Pipeline Editor Drawer ── */}
      <AnimatePresence>
        {isPipelineDrawerOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="pipeline-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsPipelineDrawerOpen(false)}
              className="fixed inset-0 bg-black/70 z-40"
            />
            {/* Drawer */}
            <motion.div
              key="pipeline-drawer"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "tween", duration: 0.25 }}
              className="fixed right-0 top-0 h-full w-full max-w-md bg-[#0a0a0a] border-l border-white/10 z-50 flex flex-col overflow-hidden"
            >
              {/* Drawer Header */}
              <div className="flex items-center justify-between px-6 py-5 border-b border-white/10 shrink-0">
                <div>
                  <h2 className="font-display text-sm font-bold text-white uppercase tracking-wider">
                    {editingPipeline ? "Edit Pipeline" : "New Pipeline"}
                  </h2>
                  <p className="text-[10px] text-white/40 font-mono mt-0.5">
                    {editingPipeline ? `ID: ${editingPipeline.id}` : "Configure a named RAG pipeline"}
                  </p>
                </div>
                <button
                  onClick={() => setIsPipelineDrawerOpen(false)}
                  className="text-white/40 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Drawer Form Body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Pipeline Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Doc-Search-Alpha"
                    value={pipelineForm.name ?? ""}
                    onChange={e => setPipelineForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-semibold text-white outline-none focus:ring-1 focus:ring-[#ccff00]"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Description</label>
                  <input
                    type="text"
                    placeholder="Short description of this pipeline's purpose"
                    value={pipelineForm.description ?? ""}
                    onChange={e => setPipelineForm(f => ({ ...f, description: e.target.value }))}
                    className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-semibold text-white outline-none focus:ring-1 focus:ring-[#ccff00]"
                  />
                </div>

                {/* Generation Model */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Generation Model</label>
                  <select
                    value={pipelineForm.generationModel ?? "gemini-3.5-flash"}
                    onChange={e => setPipelineForm(f => ({ ...f, generationModel: e.target.value }))}
                    className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-semibold text-white outline-none focus:ring-1 focus:ring-[#ccff00] cursor-pointer"
                  >
                    <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                    <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                    <option value="offline">offline (retrieval only)</option>
                  </select>
                </div>

                {/* Top-K */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Top-K Chunks</label>
                    <span className="text-xs font-mono font-bold text-[#ccff00]">{pipelineForm.topK ?? 3}</span>
                  </div>
                  <input
                    type="range" min={1} max={10} step={1}
                    value={pipelineForm.topK ?? 3}
                    onChange={e => setPipelineForm(f => ({ ...f, topK: Number(e.target.value) }))}
                    className="w-full accent-[#ccff00] cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] font-mono text-white/20">
                    <span>1 (precise)</span><span>10 (broad)</span>
                  </div>
                </div>

                {/* Min Score */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Min Similarity Score</label>
                    <span className="text-xs font-mono font-bold text-[#ccff00]">{((pipelineForm.minScore ?? 0) * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={pipelineForm.minScore ?? 0}
                    onChange={e => setPipelineForm(f => ({ ...f, minScore: Number(e.target.value) }))}
                    className="w-full accent-[#ccff00] cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] font-mono text-white/20">
                    <span>0% (all chunks)</span><span>100% (exact match)</span>
                  </div>
                </div>

                {/* System Prompt */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">System Prompt <span className="normal-case text-white/20">(leave blank for default)</span></label>
                  <textarea
                    rows={4}
                    placeholder="You are a helpful assistant. Answer only using the provided context..."
                    value={pipelineForm.systemPrompt ?? ""}
                    onChange={e => setPipelineForm(f => ({ ...f, systemPrompt: e.target.value }))}
                    className="w-full p-3 bg-black/60 border border-white/10 rounded text-xs font-mono text-white/80 outline-none focus:ring-1 focus:ring-[#ccff00] resize-none"
                  />
                </div>

                {/* Source Filter */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-white/50">Source Filter <span className="normal-case text-white/20">(leave blank = all sources)</span></label>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {sources.length === 0 ? (
                      <p className="text-[10px] text-white/20 font-mono">No indexed documents yet.</p>
                    ) : sources.map(s => {
                      const checked = (pipelineForm.sourceFilter ?? []).includes(s.id);
                      return (
                        <label key={s.id} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const current = pipelineForm.sourceFilter ?? [];
                              setPipelineForm(f => ({
                                ...f,
                                sourceFilter: checked
                                  ? current.filter(id => id !== s.id)
                                  : [...current, s.id]
                              }));
                            }}
                            className="accent-[#ccff00] cursor-pointer"
                          />
                          <span className="text-xs font-semibold text-white/60 group-hover:text-white transition-colors truncate">{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Enabled toggle */}
                <div className="flex items-center justify-between py-3 border-t border-white/10">
                  <div>
                    <p className="text-xs font-bold text-white">Enabled</p>
                    <p className="text-[10px] text-white/30 font-mono">Disabled pipelines are hidden from the playground</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPipelineForm(f => ({ ...f, enabled: !f.enabled }))}
                    className="cursor-pointer"
                  >
                    {pipelineForm.enabled
                      ? <ToggleRight className="w-8 h-8 text-[#ccff00]" />
                      : <ToggleLeft className="w-8 h-8 text-white/30" />
                    }
                  </button>
                </div>
              </div>

              {/* Drawer Footer */}
              <div className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center justify-between gap-3">
                {editingPipeline && (
                  <button
                    onClick={() => { handleDeletePipeline(editingPipeline.id); setIsPipelineDrawerOpen(false); }}
                    className="text-xs font-mono font-bold text-red-400 hover:text-red-300 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                )}
                <div className="flex items-center gap-3 ml-auto">
                  <button
                    onClick={() => setIsPipelineDrawerOpen(false)}
                    className="px-4 py-2 border border-white/10 rounded text-xs font-bold text-white/50 hover:text-white hover:border-white/30 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSavePipeline}
                    disabled={pipelineSaving || !pipelineForm.name?.trim()}
                    className="px-5 py-2 bg-[#ccff00] text-black text-xs font-bold rounded hover:opacity-90 disabled:opacity-40 flex items-center gap-2 uppercase tracking-widest cursor-pointer transition-all"
                  >
                    {pipelineSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    {pipelineSaving ? "Saving..." : editingPipeline ? "Update" : "Create"}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
