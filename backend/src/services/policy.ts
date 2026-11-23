export const HOUR = 3600000;
export interface Bucket {
  window: number;
  used: number;
  next_at: number;
}
export function allocation(
  now: number,
  old: Bucket | undefined,
  limit: number,
) {
  const window = Math.floor(now / HOUR);
  const used = old && Number(old.window) === window ? old.used : 0;
  const available = Math.max(
    Number(old?.next_at || 0),
    used >= limit ? (window + 1) * HOUR : 0,
  );
  return { window, used, available, hit: used + 1 === limit };
}
