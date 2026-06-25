import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";

import { fetchDashboard, type DashboardFeed } from "./api";
import { ExecutionDetail } from "./pages/ExecutionDetail";
import { Executions } from "./pages/Executions";

type FeedState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly feed: DashboardFeed };

export function App() {
  const [state, setState] = useState<FeedState>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDashboard(ctrl.signal)
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

  const repoSlug = state.status === "ready" ? state.feed.repoSlug : null;

  return (
    <div className="page">
      <header>
        <h1>
          <Link to="/">FlareDispatch</Link>
        </h1>
      </header>
      <p className="tagline">
        Dispatch CI/CD runs to Cloudflare — inspect logs, executions, and product demos.
      </p>

      <main>
        {state.status === "loading" && <p className="muted">Loading executions…</p>}
        {state.status === "error" && (
          <p className="empty">
            Couldn&rsquo;t load executions ({state.message}). If this persists, your
            Cloudflare Access session may have expired — reload to re-authenticate.
          </p>
        )}
        {state.status === "ready" && (
          <Routes>
            <Route path="/" element={<Executions feed={state.feed} />} />
            <Route path="/executions/:id" element={<ExecutionDetail feed={state.feed} />} />
            <Route
              path="*"
              element={
                <p className="empty">
                  Page not found. <Link to="/">Back to dashboard</Link>.
                </p>
              }
            />
          </Routes>
        )}
      </main>

      <footer>
        <a href="/v1/github/install/new">Install the GitHub App</a>
        {repoSlug !== null && <a href={`https://github.com/${repoSlug}`}>Source</a>}
      </footer>
    </div>
  );
}
