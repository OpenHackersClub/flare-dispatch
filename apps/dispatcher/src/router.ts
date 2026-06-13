// FlareDispatch Dispatcher — the request router.
//
// A thin method+path matcher over the three PR5 route modules:
//
//   GET  /health                          → routes/health.ts
//   POST /v1/dispatch/:run                 → routes/dispatch.ts
//   GET  /v1/artifacts/:execution/:name    → routes/artifacts.ts
//   GET  /v1/github/install/new            → routes/github.ts
//   GET  /v1/github/installed              → routes/github.ts
//
// Everything route-specific (HMAC verify, Schema validation, R2 streaming)
// lives in the route module; this file only matches and delegates. Anything
// unmatched 404s; a wrong method on a known path 405s.
//
// This module deliberately imports NOTHING from the Cloudflare runtime
// (`cloudflare:workers`, `@cloudflare/sandbox`) — only the route handlers and
// the typed `Env`. That keeps it (and the routes) testable under plain Node +
// Vitest 2: `index.ts` owns the runtime-coupled binding-class re-exports.
//
// Spec: specs/pm/plan.md § PR5, specs/05-byoc.md § GitHub App setup.

import type { Env } from "./env";
import { handleAdminEvent } from "./routes/admin-events";
import { handleArtifact } from "./routes/artifacts";
import { handleBrowserCdp } from "./routes/browser-cdp";
import { handleReplay } from "./routes/replay";
import { handleDispatch } from "./routes/dispatch";
import {
  handleExecutionDetail,
  handleExecutionsList,
} from "./routes/executions";
import { handleHealth } from "./routes/health";
import { handleInstallNew, handleInstalled } from "./routes/github";
import {
  handleLogFile,
  handleLogsAggregate,
  handleLogViewer,
} from "./routes/logs";
import { handleOidcDiscovery, handleOidcJwks } from "./routes/oidc";
import { handleGithubWebhook } from "./routes/webhook";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Route an inbound request to its handler. */
export const handleRequest = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  const url = new URL(request.url);
  // Split into non-empty segments: "/v1/dispatch/x" → ["v1","dispatch","x"].
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  // GET /health
  if (segments.length === 1 && segments[0] === "health") {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleHealth();
  }

  // GET /replay/:sessionId — self-hosted rrweb replay player for a Browser Run
  // Session Recording (what `product-demo.docsBase` points at on this Worker).
  if (segments.length === 2 && segments[0] === "replay") {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleReplay(env, decodeURIComponent(segments[1]!));
  }

  // GET /logs/:execution — the self-contained HTML log viewer (capability
  // token in `?t=`). The readable replacement for the truncated, JSON-escaped
  // blob the Cloudflare Workflows instance explorer shows.
  if (segments.length === 2 && segments[0] === "logs") {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleLogViewer(env, decodeURIComponent(segments[1]!), url);
  }

  // OIDC issuer endpoints — public, unauthenticated (IdPs fetch them).
  // GET /.well-known/openid-configuration
  if (
    segments.length === 2 &&
    segments[0] === ".well-known" &&
    segments[1] === "openid-configuration"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleOidcDiscovery(env);
  }
  // GET /.well-known/jwks.json
  if (
    segments.length === 2 &&
    segments[0] === ".well-known" &&
    segments[1] === "jwks.json"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleOidcJwks(env);
  }

  // POST /v1/dispatch/:run
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "dispatch"
  ) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleDispatch(request, env, decodeURIComponent(segments[2]!));
  }

  // POST /v1/webhooks/github
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "webhooks" &&
    segments[2] === "github"
  ) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleGithubWebhook(request, env);
  }

  // POST /v1/admin/events/:wf_id — signal a Workflow paused on step.waitForEvent.
  if (
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "admin" &&
    segments[2] === "events"
  ) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleAdminEvent(request, env, decodeURIComponent(segments[3]!));
  }

  // GET /v1/browser/cdp — WebSocket upgrade, bridges connectOverCDP → the
  // CF Browser Rendering binding. Used by the `cdp-acceptance` run.
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "browser" &&
    segments[2] === "cdp"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const requestId = request.headers.get("cf-ray") ?? "no-ray";
    return handleBrowserCdp(request, env, requestId);
  }

  // GET /v1/executions — ADMIN_TOKEN-gated listing of executions.
  if (
    segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "executions"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleExecutionsList(request, env, url);
  }

  // GET /v1/executions/:id[...]  — per-execution detail + logs (token-gated).
  if (
    segments.length >= 3 &&
    segments[0] === "v1" &&
    segments[1] === "executions"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const executionId = decodeURIComponent(segments[2]!);
    // GET /v1/executions/:id
    if (segments.length === 3) {
      return handleExecutionDetail(env, executionId, url);
    }
    // GET /v1/executions/:id/logs — aggregated text roll-up.
    if (segments.length === 4 && segments[3] === "logs") {
      return handleLogsAggregate(env, executionId, url);
    }
    // GET /v1/executions/:id/logs/:file — one exec log (ndjson | ?format=text).
    if (segments.length === 5 && segments[3] === "logs") {
      return handleLogFile(env, executionId, decodeURIComponent(segments[4]!), url);
    }
    return json({ error: "not_found" }, 404);
  }

  // GET /v1/artifacts/:execution/:name[/...path]
  // Bare name = the artifact object (tarball/log download). A nested path
  // serves one file out of the bundle's upload-time browse expansion; a
  // trailing slash after the name is the browse entrypoint (index.html or a
  // generated listing) — see routes/artifacts.ts.
  if (
    segments.length >= 4 &&
    segments[0] === "v1" &&
    segments[1] === "artifacts"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const subPath = segments
      .slice(4)
      .map((s) => decodeURIComponent(s))
      .join("/");
    return handleArtifact(
      env,
      decodeURIComponent(segments[2]!),
      decodeURIComponent(segments[3]!),
      subPath,
      url.pathname.endsWith("/"),
    );
  }

  // GET /v1/github/install/new — render the manifest-form page.
  if (
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "github" &&
    segments[2] === "install" &&
    segments[3] === "new"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleInstallNew(request);
  }

  // GET /v1/github/installed — the manifest-conversion callback.
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "github" &&
    segments[2] === "installed"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleInstalled(request);
  }

  return json({ error: "not_found" }, 404);
};
