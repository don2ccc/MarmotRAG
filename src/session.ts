import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Stateless signed session cookie.
 *
 * Payload: base64url(JSON {uid, ver, exp}) + "." + base64url(HMAC-SHA256).
 * `ver` is the user's token_version, so changing the password invalidates every
 * session issued before the change.
 */
export interface SessionPayload {
  uid: string;
  ver: number;
  exp: number;
}

export const SESSION_COOKIE = "marmot_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

let secret: string | null = null;

/** Set once at startup from the persisted config (survives restarts). */
export function configureSessionSecret(value: string): void {
  secret = value;
}

function key(): string {
  if (!secret) throw new Error("session secret is not configured");
  return secret;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function issueSession(userId: string, tokenVersion: number): string {
  const payload: SessionPayload = {
    uid: userId,
    ver: tokenVersion,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload?.uid || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionTokenFromRequest(req: Request): string | undefined {
  const authorization = req.headers["authorization"];
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
