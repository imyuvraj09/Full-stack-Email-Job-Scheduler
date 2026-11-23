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
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("Sign in required");
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "Request failed (" + resp.status + ")");
  }
  return resp.status === 204 ? (undefined as T) : resp.json();
}
