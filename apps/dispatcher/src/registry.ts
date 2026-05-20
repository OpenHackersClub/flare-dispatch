// FlareDispatch Dispatcher — the run registry.
//
// A name → `Run` map the routes resolve a dispatched run against. `RunWorkflow`
// (workflow.ts) keeps its own one-entry copy; this is the Dispatcher-side
// twin the `/v1/dispatch/:run` route uses to (a) 404 an unknown run and (b)
// Schema-validate `inputs` against the named run's `inputs` schema *before*
// instantiating the Workflow. `/health` lists `runNames()`.
//
// Each run slots in as another entry: `offload-test` (V0), `cdp-acceptance`
// (V2 browser acceptance, PR9), `product-demo` (V3 — Action + Schedule mode).

import type { Run, ScheduleSpec } from "@flare-dispatch/core";
import { cdpAcceptance, productDemo, offloadTest } from "@flare-dispatch/runs";

/** name → Run. The single seam new runs are registered through. */
export const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
  [cdpAcceptance.name]: cdpAcceptance as Run<unknown, unknown>,
  [productDemo.name]: productDemo as Run<unknown, unknown>,
};

/** Resolve a run by name; `undefined` for an unknown run (→ 404). */
export const lookupRun = (name: string): Run<unknown, unknown> | undefined =>
  RUN_REGISTRY[name];

/** The registered run names — sorted for a stable `/health` response. */
export const runNames = (): readonly string[] =>
  Object.keys(RUN_REGISTRY).sort();

/**
 * Find every (run, schedule-spec) pair in the registry whose `cron` matches
 * the given expression — the routing primitive Schedule mode dispatches
 * through. Multiple runs MAY share one cron (the spec calls this "free dedup
 * against the other modes" — each run's child executions keep their own
 * semantic `instanceId`).
 *
 * The cron expression match is exact-string, NOT a cron-grammar comparison:
 * `controller.cron` is whatever wrangler delivered, and the run's `schedules`
 * entry MUST use the same form. The `init` CLI (specs/pm/plan.md) eventually
 * reconciles `wrangler.jsonc` + `schedules` at deploy time; until then it is
 * the operator's job to keep them in sync — a missing match is logged at
 * warn (see routes/scheduled.ts), never a crash.
 */
export type ScheduleMatch = {
  readonly run: Run<unknown, unknown>;
  readonly schedule: ScheduleSpec<unknown>;
};

export const schedulesByCron = (cron: string): readonly ScheduleMatch[] => {
  const matches: ScheduleMatch[] = [];
  for (const run of Object.values(RUN_REGISTRY)) {
    const schedules = run.schedules;
    if (!schedules) continue;
    for (const s of schedules) {
      if (s.cron === cron) {
        matches.push({ run, schedule: s as ScheduleSpec<unknown> });
      }
    }
  }
  return matches;
};
