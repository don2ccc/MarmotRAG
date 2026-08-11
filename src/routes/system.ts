import { Router } from "express";
import {
  upsertUser, deleteUserById, pingDb, saveConfig, queryLogsPaginated, loadQueryLogs,
  type PersistedUser,
} from "../db.js";
import { store } from "../store.js";
import { visibleSources } from "./sources.js";

function currentUser(req: any): PersistedUser {
  return req.user as PersistedUser;
}

export function createSystemRouter(): Router {
  const r = Router();

  r.get("/health", async (req, res) => {
    let pgConnected = false;
    try { await pingDb(); pgConnected = true; } catch { /* offline */ }
    let ollamaConnected = false;
    try {
      const resp = await fetch(`${store.strategyConfig.ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      ollamaConnected = resp.ok;
    } catch { /* offline */ }
    res.json({
      status: pgConnected && ollamaConnected ? "healthy" : "degraded",
      pgConnected,
      ollamaConnected,
      pgHost: store.strategyConfig.pgHost,
      pgDatabase: store.strategyConfig.pgDatabase,
      ollamaBaseUrl: store.strategyConfig.ollamaBaseUrl,
    });
  });

  r.get("/config", (_req, res) => res.json(store.strategyConfig));

  r.post("/config", async (req, res) => {
    store.strategyConfig = { ...store.strategyConfig, ...(req.body ?? {}) };
    await saveConfig(store.strategyConfig as unknown as Record<string, unknown>);
    res.json({ message: "Configuration saved successfully", config: store.strategyConfig });
  });

  r.get("/stats", (_req, res) => {
    const user = currentUser(_req);
    const visible = visibleSources(user.id);
    const own = store.sources.filter(s => s.ownerId === user.id);
    const logs = store.queryLogs.filter(l => l.userId === user.id);
    res.json({
      totalVectors: visible.reduce((sum, s) => sum + s.vectorsCount, 0),
      activeSourceCount: visible.length,
      syncedSourceCount: visible.filter(s => s.status === "Synced").length,
      ownSources: own.length,
      queryCount: logs.length,
      avgLatencyMs: logs.length > 0 ? Math.round(logs.reduce((s, l) => s + l.latencyMs, 0) / logs.length) : 0,
    });
  });

  r.get("/logs", async (req, res) => {
    const user = currentUser(req);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const { logs, total } = await queryLogsPaginated({ limit, offset, userId: user.id, status, search });
    res.json({ logs, total, limit, offset });
  });

  r.get("/logs/export", async (req, res) => {
    const user = currentUser(req);
    const fmt = typeof req.query.format === "string" ? req.query.format : "json";
    const { logs } = await queryLogsPaginated({ limit: 10000, offset: 0, userId: user.id });
    if (fmt === "csv") {
      const header = "id,timestamp,via,status,latencyMs,query\n";
      const rows = logs.map(l =>
        [l.id, l.timestamp, l.via, l.status, l.latencyMs,
         `"${l.query.replace(/"/g, '""')}"`].join(",")
      ).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="marmot-logs-${Date.now()}.csv"`);
      res.send(header + rows);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="marmot-logs-${Date.now()}.json"`);
      res.json(logs);
    }
  });

  // ── Users (demo management for the switcher) ─────────────────────────
  r.get("/users", (_req, res) => res.json(store.users));

  r.post("/users", async (req, res) => {
    const { name, email, role } = req.body ?? {};
    if (!name || !email) { res.status(400).json({ error: "name and email are required" }); return; }
    const newUser: PersistedUser = {
      id: `u-${Date.now()}`,
      name: String(name).slice(0, 200),
      email: String(email).slice(0, 200),
      role: role || "Viewer",
      lastLogin: "Never",
    };
    store.users.push(newUser);
    await upsertUser(newUser);
    res.status(201).json(newUser);
  });

  r.patch("/users/:id", async (req, res) => {
    const u = store.users.find(x => x.id === req.params.id);
    if (!u) { res.status(404).json({ error: "User not found" }); return; }
    const { name, email, role, lastLogin } = req.body ?? {};
    if (name !== undefined) u.name = String(name).slice(0, 200);
    if (email !== undefined) u.email = String(email).slice(0, 200);
    if (role !== undefined) u.role = String(role).slice(0, 100);
    if (lastLogin !== undefined) u.lastLogin = String(lastLogin).slice(0, 100);
    await upsertUser(u);
    res.json(u);
  });

  r.delete("/users/:id", async (req, res) => {
    const u = store.users.find(x => x.id === req.params.id);
    if (!u) { res.status(404).json({ error: "User not found" }); return; }
    store.users = store.users.filter(x => x.id !== req.params.id);
    await deleteUserById(req.params.id);
    res.json({ message: "User removed" });
  });

  return r;
}
