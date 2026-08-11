import { ChevronDown, UserRound } from "lucide-react";
import { useState } from "react";
import type { UserInfo } from "../types";

interface Props {
  users: UserInfo[];
  currentUserId: string;
  onSwitch: (id: string) => void;
  compact?: boolean;
}

export default function UserSwitcher({ users, currentUserId, onSwitch, compact }: Props) {
  const [open, setOpen] = useState(false);
  const current = users.find(u => u.id === currentUserId) ?? users[0];
  if (!current) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer text-left"
        title="Switch demo user"
      >
        <span className="w-7 h-7 rounded-full bg-[#86C9A4] text-black flex items-center justify-center shrink-0">
          <UserRound className="w-3.5 h-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block font-bold text-white truncate ${compact ? "text-[11px]" : "text-xs"}`}>
            {current.name}
          </span>
          <span className="block font-mono text-[9px] text-white/55 uppercase tracking-wider truncate">
            {current.role} · demo
          </span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-white/55 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 mt-2 z-40 bg-[#131720] border border-white/15 rounded-lg shadow-2xl overflow-hidden">
            {users.map(u => (
              <button
                key={u.id}
                onClick={() => { onSwitch(u.id); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/5 cursor-pointer transition-colors ${
                  u.id === currentUserId ? "bg-[#86C9A4]/10 border-l-2 border-[#86C9A4]" : "border-l-2 border-transparent"
                }`}
              >
                <span className="w-6 h-6 rounded-full bg-white/10 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                  {u.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-white truncate">{u.name}</span>
                  <span className="block font-mono text-[9px] text-white/55 uppercase tracking-wider">{u.role}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
