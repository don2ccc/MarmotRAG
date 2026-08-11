import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { UserPlus, Trash2, Shield } from "lucide-react";
import { apiFetch } from "../api";
import type { UserInfo } from "../types";

interface Props {
  userId: string;
  showToast: (message: string, type?: "success" | "info" | "error") => void;
  showConfirm: (title: string, message: string, onConfirm: () => void) => void;
}

export default function AdminTab({ userId, showToast, showConfirm }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Viewer");

  useEffect(() => {
    apiFetch(userId, "/api/users").then(r => r.json()).then(setUsers).catch(() => {});
  }, [userId]);

  const addUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    try {
      const res = await apiFetch(userId, "/api/users", {
        method: "POST",
        body: JSON.stringify({ name, email, role }),
      });
      if (!res.ok) throw new Error("Failed to add user");
      const u: UserInfo = await res.json();
      setUsers(prev => [...prev, u]);
      setName(""); setEmail(""); setRole("Viewer");
      setIsAddOpen(false);
      showToast(`User ${u.name} added.`, "success");
    } catch {
      showToast("Failed to add user.", "error");
    }
  };

  const updateRole = async (id: string, nextRole: string) => {
    try {
      const res = await apiFetch(userId, `/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setUsers(prev => prev.map(u => u.id === id ? { ...u, role: updated.role } : u));
    } catch {
      showToast("Failed to update role.", "error");
    }
  };

  const deleteUser = (id: string) => {
    const u = users.find(x => x.id === id);
    showConfirm("Remove User", `Remove "${u?.name ?? id}" from the workspace?`, async () => {
      try {
        await apiFetch(userId, `/api/users/${id}`, { method: "DELETE" });
        setUsers(prev => prev.filter(x => x.id !== id));
        showToast("User removed.", "info");
      } catch {
        showToast("Failed to remove user.", "error");
      }
    });
  };

  return (
    <div className="space-y-6 p-6 md:p-8 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">Workspace Users</h2>
          <p className="font-mono text-[10px] text-white/55 uppercase tracking-wider mt-1">Demo identity switcher · SSO-ready</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#86C9A4] text-black text-xs font-bold uppercase tracking-wider rounded-lg hover:brightness-110 cursor-pointer"
        >
          <UserPlus className="w-4 h-4" /> Add User
        </button>
      </div>

      <div className="bg-[#131720] border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/10 font-mono text-[9px] uppercase tracking-widest text-white/55">
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3 hidden md:table-cell">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3 hidden md:table-cell">Last Login</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="w-7 h-7 rounded-full bg-[#86C9A4]/15 text-[#86C9A4] flex items-center justify-center text-[10px] font-bold">
                      {u.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="text-xs font-bold text-white">{u.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-white/50 hidden md:table-cell">{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={e => updateRole(u.id, e.target.value)}
                    className="bg-[#0E1218] border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4] cursor-pointer"
                  >
                    {["Super Admin", "Owner", "Editor", "Compliance", "Viewer"].map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 font-mono text-[10px] text-white/45 hidden md:table-cell">{u.lastLogin}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deleteUser(u.id)} className="p-2 text-white/45 hover:text-red-400 cursor-pointer" title="Remove user">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-start gap-3 bg-[#0E1218]/70 border border-white/5 rounded-xl p-4">
        <Shield className="w-4 h-4 text-[#86C9A4] mt-0.5 shrink-0" />
        <p className="text-[11px] text-white/55 leading-relaxed">
          Demo mode uses the header <code className="font-mono text-[#86C9A4]">X-User-Id</code> to select the current user.
          Production authentication can replace it with a session/JWT middleware without changing any route logic.
        </p>
      </div>

      {isAddOpen && (
        <form onSubmit={addUser} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={() => setIsAddOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[#131720] border border-white/15 rounded-xl p-6 w-full max-w-sm mx-4 space-y-4 shadow-2xl">
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-white">Add User</h3>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Name"
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#86C9A4]" />
            <select value={role} onChange={e => setRole(e.target.value)}
              className="w-full p-2.5 bg-[#0E1218] border border-white/10 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#86C9A4] cursor-pointer">
              {["Super Admin", "Owner", "Editor", "Compliance", "Viewer"].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <div className="flex justify-end gap-3 pt-1">
              <button type="button" onClick={() => setIsAddOpen(false)}
                className="px-4 py-2 border border-white/10 text-white/60 text-xs font-bold rounded hover:bg-white/5 cursor-pointer">Cancel</button>
              <button type="submit"
                className="px-4 py-2 bg-[#86C9A4] text-black text-xs font-bold rounded hover:brightness-110 cursor-pointer uppercase tracking-widest">Add</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
