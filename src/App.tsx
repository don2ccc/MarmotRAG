import React, { useEffect, useState } from "react";
import {
  LayoutDashboard, Sliders, FileText, Shield, Flame, Key, Sun, Moon, RefreshCw,
  CheckCircle, AlertTriangle, Info, Server,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { apiFetch } from "./api";
import UserSwitcher from "./components/UserSwitcher";
import DashboardTab from "./tabs/DashboardTab";
import WorkspaceTab from "./tabs/WorkspaceTab";
import KnowledgeBaseTab from "./tabs/KnowledgeBaseTab";
import AdminTab from "./tabs/AdminTab";
import PlaygroundTab from "./tabs/PlaygroundTab";
import ApiAccessTab from "./tabs/ApiAccessTab";
import type { IndexingProgress, SourceDoc, TabType, UserInfo } from "./types";

const NAV: { tab: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { tab: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { tab: "knowledge-base", label: "Knowledge Base", icon: FileText },
  { tab: "playground", label: "Retrieval Lab", icon: Flame },
  { tab: "api-access", label: "Agent API", icon: Key },
  { tab: "workspace", label: "Workspace", icon: Sliders },
  { tab: "admin", label: "Users", icon: Shield },
];

export default function App() {
  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const [activeTab, setActiveTab] = useState<TabType>("dashboard");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [currentUserId, setCurrentUserId] = useState("u-1");
  const [sources, setSources] = useState<SourceDoc[]>([]);
  const [indexingProgress, setIndexingProgress] = useState<Record<string, IndexingProgress>>({});
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: "success" | "info" | "error" } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const showToast = (message: string, type: "success" | "info" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setConfirmModal({ title, message, onConfirm });
  };

  const loadSources = (userId: string) => {
    apiFetch(userId, "/api/sources")
      .then(r => r.json())
      .then((d: { sources: SourceDoc[] }) => setSources(d.sources ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    apiFetch("u-1", "/api/users")
      .then(r => r.json())
      .then((u: UserInfo[]) => {
        setUsers(u);
        if (u.length > 0 && !u.some(x => x.id === currentUserId)) setCurrentUserId(u[0].id);
      })
      .catch(() => {})
      .finally(() => setIsAppLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (users.length > 0) loadSources(currentUserId);
  }, [currentUserId, users.length]);

  useEffect(() => {
    if (themeMode === "light") {
      document.body.classList.add("theme-light");
      document.body.classList.remove("theme-dark");
    } else {
      document.body.classList.add("theme-dark");
      document.body.classList.remove("theme-light");
    }
  }, [themeMode]);

  if (isAppLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0D10] text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 bg-[#86C9A4] rounded-full flex items-center justify-center">
            <span className="font-display text-lg font-extrabold text-black">M</span>
          </div>
          <RefreshCw className="w-6 h-6 text-[#86C9A4] animate-spin" />
          <p className="text-xs font-mono text-white/55 uppercase tracking-widest">Initialising MarmotRAG…</p>
        </div>
      </div>
    );
  }

  const currentUser = users.find(u => u.id === currentUserId);

  return (
    <div className="flex min-h-screen bg-[#0B0D10] text-[#f0f0f0] font-sans overflow-hidden">
      {/* Confirm Modal */}
      <AnimatePresence>
        {confirmModal && (
          <motion.div
            key="confirm-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#131720] border border-white/15 rounded p-6 max-w-sm w-full mx-4 space-y-5 shadow-2xl"
            >
              <div>
                <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">{confirmModal.title}</h3>
                <p className="text-xs text-white/60 mt-2 leading-relaxed whitespace-pre-line">{confirmModal.message}</p>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setConfirmModal(null)}
                  className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer"
                >Cancel</button>
                <button
                  onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
                  className="px-4 py-2 bg-red-500 text-white text-xs font-bold rounded hover:bg-red-400 cursor-pointer uppercase tracking-widest"
                >Confirm</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={`fixed bottom-6 right-6 z-[90] pointer-events-none max-w-[calc(100vw-2rem)] p-4 rounded border flex items-start gap-3 shadow-xl ${
              toast.type === "success" ? "bg-black border-[#86C9A4] text-white" :
              toast.type === "error" ? "bg-black border-red-500 text-white" :
              "bg-black border-white/20 text-white"
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {toast.type === "success" && <CheckCircle className="w-4 h-4 text-[#86C9A4]" />}
              {toast.type === "error" && <AlertTriangle className="w-4 h-4 text-red-500" />}
              {toast.type === "info" && <Info className="w-4 h-4 text-white/60" />}
            </div>
            <span className="text-xs font-mono font-bold tracking-tight leading-relaxed">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className="hidden md:flex flex-col h-dvh py-6 px-4 gap-6 border-r border-white/10 bg-[#0F1216] w-64 fixed left-0 top-0 z-20">
        <div className="flex items-center gap-3 px-1 mb-1">
          <div className="w-9 h-9 bg-[#86C9A4] rounded-full flex items-center justify-center shrink-0">
            <span className="font-display text-sm font-extrabold text-black uppercase tracking-tighter">M</span>
          </div>
          <div>
            <h1 className="font-display text-sm font-bold tracking-tighter uppercase text-white leading-none">Marmot RAG</h1>
            <p className="font-mono text-[9px] text-[#86C9A4] uppercase tracking-wider font-bold mt-1.5">RETRIEVAL SERVICE</p>
          </div>
        </div>

        <div className="px-1">
          <UserSwitcher users={users} currentUserId={currentUserId} onSwitch={setCurrentUserId} />
        </div>

        <nav className="flex-1 space-y-1.5">
          {NAV.map(({ tab, label, icon: Icon }) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                activeTab === tab
                  ? "bg-[#86C9A4]/10 text-[#86C9A4] border border-[#86C9A4]/25"
                  : "text-white/45 hover:text-white hover:bg-white/5 border border-transparent"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="space-y-2 px-1">
          <div className="flex items-center gap-2 text-[9px] font-mono text-white/45 uppercase tracking-wider">
            <Server className="w-3.5 h-3.5" />
            <span>{currentUser?.name ?? "u-1"}</span>
          </div>
          <button
            onClick={() => setThemeMode(m => m === "dark" ? "light" : "dark")}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-white/10 text-white/50 hover:text-white hover:bg-white/5 text-[10px] font-mono uppercase tracking-wider cursor-pointer"
          >
            <span>Theme</span>
            {themeMode === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 md:ml-64 pb-24 md:pb-0">
        {/* Mobile header */}
        <div className="md:hidden sticky top-0 z-20 bg-[#0F1216]/95 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 bg-[#86C9A4] rounded-full flex items-center justify-center shrink-0">
            <span className="font-display text-xs font-extrabold text-black">M</span>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xs font-bold uppercase text-white leading-none">Marmot RAG</h1>
            <p className="font-mono text-[8px] text-[#86C9A4] uppercase font-bold mt-1">Retrieval Service</p>
          </div>
          <div className="w-36">
            <UserSwitcher users={users} currentUserId={currentUserId} onSwitch={setCurrentUserId} compact />
          </div>
        </div>

        {activeTab === "dashboard" && <DashboardTab userId={currentUserId} />}
        {activeTab === "workspace" && <WorkspaceTab userId={currentUserId} showToast={showToast} />}
        {activeTab === "knowledge-base" && (
          <KnowledgeBaseTab
            userId={currentUserId}
            sources={sources}
            setSources={setSources}
            indexingProgress={indexingProgress}
            setIndexingProgress={setIndexingProgress}
            showToast={showToast}
            showConfirm={showConfirm}
          />
        )}
        {activeTab === "admin" && <AdminTab userId={currentUserId} showToast={showToast} showConfirm={showConfirm} />}
        {activeTab === "playground" && <PlaygroundTab userId={currentUserId} showToast={showToast} />}
        {activeTab === "api-access" && (
          <ApiAccessTab userId={currentUserId} sources={sources} showToast={showToast} showConfirm={showConfirm} />
        )}
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-[#0F1216]/95 backdrop-blur border-t border-white/10 flex pb-[env(safe-area-inset-bottom)]">
        {NAV.slice(0, 5).map(({ tab, label, icon: Icon }) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 cursor-pointer ${
              activeTab === tab ? "text-[#86C9A4]" : "text-white/55"
            }`}
          >
            <Icon className="w-4 h-4" />
            <span className="text-[8px] font-mono uppercase tracking-wide">{label.split(" ")[0]}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
