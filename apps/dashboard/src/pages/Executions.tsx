import { Link } from "react-router-dom";

import type { DashboardFeed } from "../api";
import { badgeClass, relativeTime, shortSha } from "../format";

/**
 * The executions list. Each row deep-links to its detail page (the run name is
 * the stretched click target — see `.rowlink` in styles.css); the explicit
 * Logs / Demo links navigate straight to the tokened viewer surfaces.
 */
export function Executions({ feed }: { readonly feed: DashboardFeed }) {
  const now = Date.now();

  if (feed.rows.length === 0) {
    return <p className="empty">No executions yet. Dispatch a run to see it appear here.</p>;
  }

  return (
    <>
      <h2>Latest executions</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Run</th>
            <th>Repo</th>
            <th>Started</th>
            <th>View</th>
          </tr>
        </thead>
        <tbody>
          {feed.rows.map((row) => (
            <tr key={row.id} className="rowlink">
              <td>
                <span className={`badge ${badgeClass(row.status)}`}>{row.status}</span>
              </td>
              <td className="run">
                <Link to={`/executions/${encodeURIComponent(row.id)}`}>{row.run}</Link>
              </td>
              <td>
                <span className="repo">{row.repo}</span>{" "}
                <span className="sha">{shortSha(row.sha)}</span>
              </td>
              <td className="when">{relativeTime(row.startedAt, now)}</td>
              <td className="links">
                {row.logsUrl !== null && <a href={row.logsUrl}>Logs</a>}
                {row.demosUrl !== null && <a href={row.demosUrl}>Demo</a>}
                {row.logsUrl === null && row.demosUrl === null && (
                  <span className="when">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
