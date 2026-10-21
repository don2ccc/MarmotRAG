import { Router } from "express";
import {
  findUserByEmail,
  findUserById,
  setUserPassword,
  touchUserLogin,
} from "../db.js";
import { hashPassword, passwordProblem, verifyPassword } from "../password.js";
import {
  clearSessionCookie,
  issueSession,
  sessionTokenFromRequest,
  setSessionCookie,
  verifySession,
} from "../session.js";

/** Very small in-memory brute-force guard for the single admin account. */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function clientKey(ip: string | undefined): string {
  return ip ?? "unknown";
}

function isLocked(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

function publicUser(user: { id: string; name: string; email: string; role: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function createAuthRouter(): Router {
  const r = Router();

  // ── Sign in ───────────────────────────────────────────────────────────
  r.post("/login", async (req, res) => {
    const key = clientKey(req.ip);
    if (isLocked(key)) {
      res.status(429).json({ error: "Too many failed attempts. Try again later." });
      return;
    }

    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      res.status(400).json({ error: "email and password are required." });
      return;
    }

    try {
      const user = await findUserByEmail(email.trim());
      // Same response for "unknown user" and "wrong password".
      if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        recordFailure(key);
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }

      attempts.delete(key);
      await touchUserLogin(user.id);

      const token = issueSession(user.id, user.tokenVersion);
      setSessionCookie(req, res, token);
      res.json({ token, user: publicUser(user) });
    } catch (err) {
      console.error("[auth/login] failed:", err);
      res.status(500).json({ error: "Sign-in failed." });
    }
  });

  r.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ── Current session ───────────────────────────────────────────────────
  r.get("/me", async (req, res) => {
    const payload = verifySession(sessionTokenFromRequest(req));
    if (!payload) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }
    try {
      const user = await findUserById(payload.uid);
      if (!user || user.tokenVersion !== payload.ver) {
        res.status(401).json({ error: "Session is no longer valid." });
        return;
      }
      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error("[auth/me] failed:", err);
      res.status(500).json({ error: "Failed to load the session." });
    }
  });

  // ── Change password (revokes every other session) ────────────────────
  r.post("/password", async (req, res) => {
    const payload = verifySession(sessionTokenFromRequest(req));
    if (!payload) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }

    const { currentPassword, newPassword } = req.body ?? {};
    const problem = passwordProblem(newPassword);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    try {
      const user = await findUserById(payload.uid);
      if (!user || user.tokenVersion !== payload.ver) {
        res.status(401).json({ error: "Session is no longer valid." });
        return;
      }
      if (!verifyPassword(String(currentPassword ?? ""), user.passwordHash)) {
        res.status(400).json({ error: "Current password is incorrect." });
        return;
      }

      await setUserPassword(user.id, hashPassword(newPassword));
      const refreshed = await findUserById(user.id);
      if (!refreshed) {
        res.status(500).json({ error: "Account disappeared." });
        return;
      }
      // Keep this browser signed in, invalidate the rest.
      const token = issueSession(refreshed.id, refreshed.tokenVersion);
      setSessionCookie(req, res, token);
      res.json({ ok: true, token });
    } catch (err) {
      console.error("[auth/password] failed:", err);
      res.status(500).json({ error: "Failed to change the password." });
    }
  });

  return r;
}
