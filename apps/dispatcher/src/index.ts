// FlareDispatch Dispatcher Worker — V0 walking-skeleton entry point.
//
// The Worker `fetch` handler serves `GET /health`; every other path 404s. The
// `/v1/dispatch/:run` route, HMAC verify, and the artifact endpoint land in
// PR5. The Workflow body (`RunWorkflow`) and the live runtime Layers landed in
// PR4 — see workflow.ts and `@flare-dispatch/runtime-cf`.
//
// wrangler resolves two Durable Object / Workflow classes from this entry, so
// both are re-exported here:
//   * `RunWorkflow`  — the Workflow class (workflow.ts).
//   * `RunSandbox`   — the Container-backed Durable Object class (below).

import type { Env } from "./env";
import { RunSandbox } from "./sandbox";

// Re-export the binding classes so wrangler's `main` entry resolves them.
export { RunWorkflow } from "./workflow";
export { RunSandbox };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" });
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
