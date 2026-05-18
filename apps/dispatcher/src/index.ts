// FlareDispatch Dispatcher Worker — V0 walking-skeleton entry point.
//
// PR1 ships the minimal shell: `GET /health` returns {"status":"ok"}, every
// other path 404s. HMAC verify, the `/v1/dispatch/:run` route, and the
// artifact endpoint land in PR5; the RunWorkflow body lands in PR4.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * RunWorkflow — the single Workflow class bound as `RUNS_WORKFLOW`.
 *
 * PR1 stub: an empty `run` so wrangler accepts the `workflows` binding and the
 * dry-run succeeds. PR4 maps each `step.do(...)` to a run `step(...)` boundary
 * under an Effect runtime.
 */
export class RunWorkflow extends WorkflowEntrypoint<Env> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep): Promise<void> {
    // Not implemented in V0 PR1 — see specs/pm/plan.md § 4 PR 4.
  }
}

/**
 * RunSandbox — the Durable Object class backing the `RUNS_SANDBOX` container
 * binding. PR1 stub so the migration / binding is valid; the live exec surface
 * lands with the runtime Layers in PR4.
 */
export class RunSandbox extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    // Not implemented in V0 PR1 — see specs/pm/plan.md § 4 PR 4.
    return new Response("not implemented", { status: 501 });
  }
}

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
