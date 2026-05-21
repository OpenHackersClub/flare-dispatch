// FlareDispatch Dispatcher — the request router.
//
// A thin method+path matcher over the route modules:
//
//   GET  /health                              → routes/health.ts
//   POST /v1/dispatch/:run                     → routes/dispatch.ts
//   GET  /v1/artifacts/:execution/:name        → routes/artifacts.ts
//   GET  /v1/github/start                      → routes/github-start.ts
//   GET  /v1/github/installed                  → routes/github-installed.ts
//
// Everything route-specific (HMAC verify, Schema validation, R2 streaming,
// manifest-exchange) lives in the route module; this file only matches and
// delegates. Anything unmatched 404s; a wrong method on a known path 405s.
//
// This module deliberately imports NOTHING from the Cloudflare runtime
// (`cloudflare:workers`, `@cloudflare/sandbox`) — only the route handlers and
// the typed `Env`. That keeps it (and the routes) testable under plain Node +
// Vitest 2: `index.ts` owns the runtime-coupled binding-class re-exports.
//
// Spec: specs/pm/plan.md § PR5, specs/05-byoc.md § GitHub App setup.

import type { Env } from "./env";
import { handleArtifact } from "./routes/artifacts";
import { handleDispatch } from "./routes/dispatch";
import { handleGithubInstalled } from "./routes/github-installed";
import { handleGithubStart } from "./routes/github-start";
import { handleHealth } from "./routes/health";

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

  // GET /v1/github/start
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "github" &&
    segments[2] === "start"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleGithubStart(request, env);
  }

  // GET /v1/github/installed
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "github" &&
    segments[2] === "installed"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    return handleGithubInstalled(request, env);
  }

  return json({ error: "not_found" }, 404);
};
