/**
 * Demo-mode API wrapper: every request carries X-User-Id so the server can
 * scope data to the current user. Replace with real session/JWT auth later.
 */
export async function apiFetch(userId: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-User-Id", userId);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

export async function apiFetchJson<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(userId, path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
