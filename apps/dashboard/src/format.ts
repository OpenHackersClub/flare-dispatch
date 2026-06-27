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

/** Compact wall-time, e.g. "42s", "7m", "7m12s", "—" when unknown. */
export const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
};

/**
 * Integer micro-USD → short USD string (mirrors @flare-dispatch/core
 * `formatMicroUsd`; replicated here as the dashboard is a separate build).
 * 4 decimals under $1, 2 at/above; `null` → "—".
 */
export const formatMicroUsd = (microUsd: number | null): string => {
  if (microUsd === null) return "—";
  const usd = microUsd / 1_000_000;
  if (usd === 0) return "$0";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

/** Hover text explaining a cost basis — the metered-vs-modeled honesty label. */
export const basisTitle = (basis: string | null): string => {
  switch (basis) {
    case "metered":
      return "Metered — real model-token cost from the gateway usage block";
    case "mixed":
      return "Mixed — metered model tokens + modeled container compute";
    case "modeled":
      return "Modeled — estimated from instance vCPU/mem × wall-time";
    case "unmetered":
      return "Unmetered — account-billed Workers AI Neurons (no per-call tokens)";
    default:
      return "Cost not computed for this execution";
  }
};
