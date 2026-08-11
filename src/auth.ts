import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AgentApiKey } from "./types";
import type { PersistedUser } from "./db";

/**
 * Demo-mode user resolution. Reads `X-User-Id`, falls back to the first user.
 * Future real authentication only needs to replace this middleware
 * (e.g. session/JWT that sets req.user the same way).
 */
export function createResolveUser(getUsers: () => PersistedUser[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const users = getUsers();
    if (users.length === 0) {
      res.status(503).json({ error: "No users configured." });
      return;
    }
    const header = req.headers["x-user-id"];
    const user = typeof header === "string" ? users.find(u => u.id === header) : undefined;
    (req as any).user = user ?? users[0];
    next();
  };
}

/** Agent API key authentication + per-key sliding-window rate limiting. */
export function createAgentAuth(deps: {
  getKeys: () => AgentApiKey[];
  persistKey: (k: AgentApiKey) => Promise<void>;
}): RequestHandler {
  const rateLimitWindows: Record<string, { windowStart: number; count: number }> = {};

  return (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers["x-api-key"] as string | undefined;
    if (!raw) {
      res.status(401).json({ error: "Missing X-API-Key header." });
      return;
    }
    const keyRecord = deps.getKeys().find(k => k.key === raw);
    if (!keyRecord) {
      res.status(401).json({ error: "Invalid API key." });
      return;
    }
    if (!keyRecord.enabled) {
      res.status(403).json({ error: "This API key has been disabled." });
      return;
    }

    // Rate limit check (sliding 60-second window)
    if (keyRecord.rateLimit > 0) {
      const now = Date.now();
      const win = rateLimitWindows[keyRecord.id] ?? { windowStart: now, count: 0 };
      if (now - win.windowStart > 60_000) {
        win.windowStart = now;
        win.count = 0;
      }
      win.count++;
      rateLimitWindows[keyRecord.id] = win;
      if (win.count > keyRecord.rateLimit) {
        res.status(429).json({ error: `Rate limit exceeded. Max ${keyRecord.rateLimit} req/min.` });
        return;
      }
    }

    // Update usage counters in memory + persist async
    const nowIso = new Date().toISOString();
    const monthStamp = nowIso.slice(0, 7);
    keyRecord.lastUsedAt = nowIso;
    keyRecord.usageCount++;
    if (keyRecord._monthStamp !== monthStamp) {
      keyRecord._monthStamp = monthStamp;
      keyRecord.usageThisMonth = 0;
    }
    keyRecord.usageThisMonth++;
    deps.persistKey({ ...keyRecord }).catch(() => {});

    (req as any).agentKey = keyRecord;
    next();
  };
}

/** 403 helper for non-owner access. */
export function denyIfNotOwner(ownerId: string, req: Request, res: Response): boolean {
  const user = (req as any).user as PersistedUser;
  if (!user || user.id !== ownerId) {
    res.status(403).json({ error: "Only the owner can modify this resource." });
    return true;
  }
  return false;
}
