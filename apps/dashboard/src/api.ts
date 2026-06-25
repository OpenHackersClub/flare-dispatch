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
