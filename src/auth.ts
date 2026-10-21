import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AgentApiKey } from "./types.js";
import type { PersistedUser } from "./db.js";
import { findUserById } from "./db.js";
import { sessionTokenFromRequest, verifySession } from "./session.js";

/**
 * Admin-only gate for the dashboard API.
 *
 * A request is accepted when it carries a valid signed session (cookie, or a
 * bearer token returned by /api/auth/login) whose user still exists and whose
 * `token_version` matches — changing the password therefore revokes old
 * sessions. Requests carrying X-API-Key are delegated to the agent middleware,
 * which has its own auth and scope.
 */
export function createRequireAdmin(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (typeof req.headers["x-api-key"] === "string") {
      next();
      return;
    }

    const payload = verifySession(sessionTokenFromRequest(req));
    if (!payload) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    try {
      const user = await findUserById(payload.uid);
      if (!user || user.tokenVersion !== payload.ver) {
        res.status(401).json({ error: "Session is no longer valid. Sign in again." });
        return;
      }
      (req as { user?: PersistedUser }).user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        lastLogin: "",
      };
      next();
    } catch (err) {
      console.error("[auth] session lookup failed:", err);
      res.status(500).json({ error: "Authentication failed." });
    }
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

    (req as { agentKey?: AgentApiKey }).agentKey = keyRecord;
    next();
  };
}
