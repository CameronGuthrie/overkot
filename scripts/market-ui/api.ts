/** Desktop API transport. Credentials and HTTP requests stay in Electron main. */
import { marketBridge } from "../overkot/desktop";

export function apiUrl(path: string): string {
  if (!/^\/v1(?:\/|\?|$)/.test(path)) throw new Error("Expected a market API path beginning with /v1.");
  return `/api${path}`;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  apiUrl(path);
  options.signal?.throwIfAborted();
  const method = (options.method ?? "GET").toUpperCase();
  let body: unknown;
  if (options.body != null) {
    if (typeof options.body !== "string") throw new Error("The desktop market expects a JSON request body.");
    body = JSON.parse(options.body);
  }
  const result = await marketBridge().request({ path, method, ...(body !== undefined ? { body } : {}) });
  options.signal?.throwIfAborted();
  return new Response([204, 205, 304].includes(result.status) ? null : JSON.stringify(result.body ?? {}), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}
