// The SPA's only data source: the dispatcher's Access-gated `/v1/dashboard.json`
// feed (apps/dispatcher/src/http-app.ts → `dashboardJsonRoute`). These types
// mirror the dispatcher's `DashboardRow` (apps/dispatcher/src/dashboard.ts) and
// are kept in lockstep by hand — the feed is a small, stable contract.

export interface DashboardRow {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Wall-time in ms, or `null` while running. */
  readonly durationMs: number | null;
  /** Per-execution cost in integer micro-USD, or `null` if not computed. */
  readonly costMicroUsd: number | null;
  /** `metered | mixed | modeled | unmetered`, or `null` if absent. */
  readonly costBasis: string | null;
  /** Tokened `/logs` URL, or `null` when no log-link secret is configured. */
  readonly logsUrl: string | null;
  /** Tokened `/demos` URL — only set for `product-demo` runs. */
  readonly demosUrl: string | null;
}

export interface DashboardFeed {
  readonly origin: string;
  readonly repoSlug: string;
  readonly rows: readonly DashboardRow[];
}

/** One recipe's MEASURED speed+cost rollup (mirrors the dispatcher's
 *  `RunAnalytics`, apps/dispatcher/src/executions-read.ts). */
export interface RunAnalytics {
  readonly run: string;
  readonly count: number;
  readonly successRate: number;
  readonly p50DurationMs: number | null;
  readonly p95DurationMs: number | null;
  readonly avgCostMicroUsd: number | null;
  readonly totalCostMicroUsd: number;
  readonly costSamples: number;
  readonly basis: string | null;
}

export interface AnalyticsFeed {
  readonly repoSlug: string;
  /** How many recent finished executions the aggregate sampled. */
  readonly sampled: number;
  readonly runs: readonly RunAnalytics[];
  /** Deep-link to this deploy's Cloudflare AI Gateway analytics (the detailed
   *  per-request token/cost/latency view), or `null` if no gateway is configured. */
  readonly aiGatewayUrl: string | null;
}

/**
 * Fetch the executions feed. Sends the Access cookie (`credentials: include`)
 * so the in-Worker Cloudflare Access gate authorizes the read; a non-OK
 * response (401/403/503) surfaces as a thrown error the UI renders as a
 * re-authenticate hint.
 */
export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardFeed> {
  const res = await fetch("/v1/dashboard.json", {
    signal,
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`feed responded ${res.status}`);
  }
  return (await res.json()) as DashboardFeed;
}

/**
 * Fetch the MEASURED per-recipe analytics aggregate (the `/v1/analytics.json`
 * feed). Same Access-gated contract as `fetchDashboard`.
 */
export async function fetchAnalytics(signal?: AbortSignal): Promise<AnalyticsFeed> {
  const res = await fetch("/v1/analytics.json", {
    signal,
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`analytics responded ${res.status}`);
  }
  return (await res.json()) as AnalyticsFeed;
}
