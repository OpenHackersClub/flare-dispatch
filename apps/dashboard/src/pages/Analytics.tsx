import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchAnalytics, type AnalyticsFeed } from "../api";
import { basisTitle, formatDuration, formatMicroUsd } from "../format";

type State =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly feed: AnalyticsFeed };

/**
 * MEASURED per-recipe analytics — real speed (p50/p95 wall-time) and cost
 * (averaged over executions that carry a rollup) from D1, grouped by run. The
 * public docs `/benchmarks` page carries the MODELED twin; this is the live one.
 * Each cost cell labels its basis (metered vs modeled) so the numbers stay honest.
 */
export function Analytics() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAnalytics(ctrl.signal)
      .then((feed) => setState({ status: "ready", feed }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "request failed",
        });
      });
    return () => ctrl.abort();
  }, []);

  if (state.status === "loading") {
    return <p className="muted">Loading analytics…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="empty">
        Couldn&rsquo;t load analytics ({state.message}). Your Cloudflare Access session
        may have expired — reload to re-authenticate.
      </p>
    );
  }

  const { runs, sampled, aiGatewayUrl } = state.feed;

  return (
    <>
      <div className="section-head">
        <h2>Recipe analytics</h2>
        <Link to="/" className="subnav">
          ← Executions
        </Link>
      </div>
      <p className="muted">
        Measured over the last {sampled} finished executions. Cost is{" "}
        <strong>metered</strong> where the model returns token usage and{" "}
        <strong>modeled</strong> (instance × wall-time) for container compute — hover a
        cost for its basis.
      </p>
      {aiGatewayUrl !== null && (
        <p className="muted">
          For the detailed per-request token, cost, cache, and latency breakdown by
          model and provider, see{" "}
          <a href={aiGatewayUrl} target="_blank" rel="noreferrer noopener">
            this deploy&rsquo;s Cloudflare AI Gateway analytics ↗
          </a>
          .
        </p>
      )}
      {runs.length === 0 ? (
        <p className="empty">No finished executions to analyse yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Recipe</th>
              <th>Runs</th>
              <th>Success</th>
              <th>p50</th>
              <th>p95</th>
              <th>Avg cost</th>
              <th>Total cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run}>
                <td className="run">{r.run}</td>
                <td className="when">{r.count}</td>
                <td className="when">{Math.round(r.successRate * 100)}%</td>
                <td className="when">{formatDuration(r.p50DurationMs)}</td>
                <td className="when">{formatDuration(r.p95DurationMs)}</td>
                <td className="cost" title={basisTitle(r.basis)}>
                  {formatMicroUsd(r.avgCostMicroUsd)}
                  {r.basis !== null && r.basis !== "metered" && (
                    <span className="basis">{r.basis}</span>
                  )}
                </td>
                <td className="cost">{formatMicroUsd(r.totalCostMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
