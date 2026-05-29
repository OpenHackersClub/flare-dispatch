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
import { handleDispatch } from "./routes/dispatch";
import { handleHealth } from "./routes/health";
import { handleInstallNew, handleInstalled } from "./routes/github";
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

  // GET /v1/artifacts/:execution/:name
  if (
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "artifacts"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleArtifact(
      env,
      decodeURIComponent(segments[2]!),
      decodeURIComponent(segments[3]!),
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
