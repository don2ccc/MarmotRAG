/**
 * Admin console API client.
 *
 * Authentication is a signed session cookie set by /api/auth/login, so the
 * browser sends it automatically. `userId` is kept as the first argument so
 * existing call sites stay unchanged — the server no longer reads it.
 */
export async function apiFetch(_userId: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

export async function apiFetchJson<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(userId, path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
