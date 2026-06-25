// Presentation helpers mirrored from the SSR dashboard
// (apps/dispatcher/src/dashboard.ts) so the SPA and the fallback page render
// identically.

/** Map an execution status onto a badge CSS modifier. */
export const badgeClass = (status: string): string => {
  switch (status) {
    case "success":
      return "ok";
    case "failure":
      return "fail";
    case "cancelled":
      return "muted";
    case "running":
    case "started":
      return "live";
    default:
      return "pending";
  }
};

/** Compact relative time, e.g. "3m ago", "2h ago", "—" when unknown. */
export const relativeTime = (atMs: number | null, nowMs: number): string => {
  if (atMs === null) return "—";
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.round(deltaM / 60);
  if (deltaH < 48) return `${deltaH}h ago`;
  return `${Math.round(deltaH / 24)}d ago`;
};

/** Short 7-char sha for display. */
export const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);
