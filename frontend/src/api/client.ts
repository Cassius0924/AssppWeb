import { getAccessToken } from "../components/Auth/PasswordGate";
import { createLogger } from "../utils/logger";

const BASE_URL = "";
const log = createLogger("api");

async function readError(res: Response, method: string, path: string) {
  const text = await res.text();
  log.warn("request failed", {
    method,
    path,
    status: res.status,
    body: text.slice(0, 200),
  });
  return new Error(text);
}

export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { "X-Access-Token": token } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw await readError(res, "GET", path);
  return res.json();
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await readError(res, "POST", path);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw await readError(res, "DELETE", path);
}
