import { Link, useParams } from "react-router-dom";

import type { DashboardFeed } from "../api";
import { badgeClass, relativeTime, shortSha } from "../format";

/**
 * The drill-down for a single execution. Resolves the row from the already-
 * loaded feed (so a refresh / deep-link to `/executions/:id` works via the SPA
 * fallback), shows its metadata, and links out to the log viewer. We link
 * rather than embed because the `/logs` viewer sets `frame-ancestors 'none'`.
 */
export function ExecutionDetail({ feed }: { readonly feed: DashboardFeed }) {
  const { id } = useParams();
  const row = feed.rows.find((r) => r.id === id);
  const now = Date.now();

  if (row === undefined) {
    return (
      <p className="empty">
        Execution not in the latest {feed.rows.length}. <Link to="/">Back to dashboard</Link>.
      </p>
    );
  }

  return (
    <article className="detail">
      <p className="crumb">
        <Link to="/">← All executions</Link>
      </p>
      <h2>
        {row.run} <span className={`badge ${badgeClass(row.status)}`}>{row.status}</span>
      </h2>

      <dl className="meta">
        <dt>Execution</dt>
        <dd className="sha">{row.id}</dd>
        <dt>Repo</dt>
        <dd>{row.repo}</dd>
        <dt>Ref</dt>
        <dd className="sha">{row.ref}</dd>
        <dt>Commit</dt>
        <dd className="sha">{shortSha(row.sha)}</dd>
        <dt>Started</dt>
        <dd className="when">{relativeTime(row.startedAt, now)}</dd>
        <dt>Completed</dt>
        <dd className="when">{relativeTime(row.completedAt, now)}</dd>
      </dl>

      <div className="actions">
        {row.logsUrl !== null ? (
          <a className="btn" href={row.logsUrl}>
            Open logs →
          </a>
        ) : (
          <span className="muted">No logs available for this execution.</span>
        )}
        {row.demosUrl !== null && (
          <a className="btn" href={row.demosUrl}>
            Watch demo →
          </a>
        )}
      </div>
    </article>
  );
}
