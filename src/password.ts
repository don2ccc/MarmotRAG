import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt (Node built-in, no extra dependency).
 * Format: scrypt$<salt hex>$<hash hex>
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length === 0) return false;
  try {
    const actual = scryptSync(password, Buffer.from(parts[1], "hex"), expected.length, {
      N: 16384, r: 8, p: 1,
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Minimum bar for the admin password; the console is a high-value target. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 200) return "Password is too long.";
  return null;
}
