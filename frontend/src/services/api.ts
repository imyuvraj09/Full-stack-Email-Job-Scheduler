export interface Me {
  user: { name: string; email: string; avatar: string; connected: boolean };
  senders: { id: string; address: string }[];
  gap: number;
  cap: number;
  admin: boolean;
}
export interface Email {
  id: string;
  recipient: string;
  subject: string;
  due: string;
  finished: string | null;
  status: string;
  detail: string | null;
  preview: string | null;
}
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const endpoint = url.startsWith("http") ? url : `${API_BASE}${url}`;
  const response = await fetch(endpoint, {
    ...init,
    credentials: "include",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in required");
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed (" + response.status + ")");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
