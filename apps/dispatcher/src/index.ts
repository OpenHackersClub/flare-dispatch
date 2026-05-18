// FlareDispatch Dispatcher Worker — V0 walking-skeleton entry point.
//
// This file is the Cloudflare-runtime seam: the `fetch` handler and the two
// binding-class re-exports wrangler resolves from `main`. All routing logic
// lives in `router.ts` (and the `routes/` modules) — kept free of
// `cloudflare:workers` / `@cloudflare/sandbox` imports so it stays testable
// under plain Node + Vitest 2.
//
//   GET  /health                          → routes/health.ts
//   POST /v1/dispatch/:run                 → routes/dispatch.ts
//   GET  /v1/artifacts/:execution/:name    → routes/artifacts.ts
//
// wrangler resolves two Durable Object / Workflow classes from this entry:
//   * `RunWorkflow`  — the Workflow class (workflow.ts).
//   * `RunSandbox`   — the Container-backed Durable Object class (sandbox.ts).
//
// Spec: specs/pm/plan.md § PR5.

import type { Env } from "./env";
import { handleRequest } from "./router";
import { RunSandbox } from "./sandbox";

// Re-export the binding classes so wrangler's `main` entry resolves them.
export { RunWorkflow } from "./workflow";
export { RunSandbox };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
