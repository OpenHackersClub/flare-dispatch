// FlareDispatch Dispatcher Worker — V0 walking-skeleton entry point.
//
// This file is the Cloudflare-runtime seam: the `fetch` + `scheduled` handlers
// and the two binding-class re-exports wrangler resolves from `main`. All
// routing logic lives in `router.ts` / `routes/scheduled.ts` — kept free of
// `cloudflare:workers` / `@cloudflare/sandbox` imports so they stay testable
// under plain Node + Vitest 2.
//
//   GET  /health                          → routes/health.ts
//   POST /v1/dispatch/:run                 → routes/dispatch.ts
//   GET  /v1/artifacts/:execution/:name    → routes/artifacts.ts
//   (CF Cron Trigger → `scheduled`)        → routes/scheduled.ts
//
// wrangler resolves two Durable Object / Workflow classes from this entry:
//   * `RunWorkflow`  — the Workflow class (workflow.ts).
//   * `RunSandbox`   — the Container-backed Durable Object class (sandbox.ts).
//
// Spec: specs/pm/plan.md § PR5, specs/04-gha-integration.md § Schedule mode.

import type { Env } from "./env";
import { handleRequest } from "./router";
import { handleScheduled } from "./routes/scheduled";
import { RunSandbox } from "./sandbox";

// Re-export the binding classes so wrangler's `main` entry resolves them.
export { RunWorkflow } from "./workflow";
export { RunSandbox };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  /**
   * Cron Trigger entry — fires once per `triggers.crons` cadence. We hand off
   * to `handleScheduled` via `ctx.waitUntil` so the runtime keeps the Worker
   * alive long enough to fan out (each match's `env.RUNS_WORKFLOW.create()`
   * is an async I/O the runtime would otherwise tear down on handler return).
   */
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      handleScheduled(env, controller.cron, controller.scheduledTime),
    );
  },
} satisfies ExportedHandler<Env>;
