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

import type { Run, ScheduleSpec, TriggerSpec } from "@flare-dispatch/core";
import {
  cdpAcceptance,
  ciTriagePr,
  deploySmoke,
  matrixFanout,
  multiAgentReview,
  offloadTest,
  playwrightDemo,
  playwrightE2E,
  prReview,
  productDemo,
  specDriftPr,
} from "@flare-dispatch/runs";

/** name → Run. The single seam new runs are registered through. */
export const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
  [cdpAcceptance.name]: cdpAcceptance as Run<unknown, unknown>,
  [deploySmoke.name]: deploySmoke as Run<unknown, unknown>,
  [matrixFanout.name]: matrixFanout as Run<unknown, unknown>,
  [playwrightE2E.name]: playwrightE2E as Run<unknown, unknown>,
  [productDemo.name]: productDemo as Run<unknown, unknown>,
  [playwrightDemo.name]: playwrightDemo as Run<unknown, unknown>,
  [prReview.name]: prReview as Run<unknown, unknown>,
  [multiAgentReview.name]: multiAgentReview as Run<unknown, unknown>,
  [specDriftPr.name]: specDriftPr as Run<unknown, unknown>,
  [ciTriagePr.name]: ciTriagePr as Run<unknown, unknown>,
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

/**
 * Find every (run, trigger-spec) pair in the registry whose `event` matches
 * the inbound GitHub webhook event. The Webhook-mode counterpart to
 * `schedulesByCron`. Filtering by trigger `actions[]` happens at the receiver
 * (spec 04-gha § Webhook mode) once we've read the payload's `action` field.
 */
export type TriggerMatch = {
  readonly run: Run<unknown, unknown>;
  readonly trigger: TriggerSpec<unknown>;
};

export const triggersByEvent = (event: string): readonly TriggerMatch[] => {
  const matches: TriggerMatch[] = [];
  for (const run of Object.values(RUN_REGISTRY)) {
    const triggers = run.triggers;
    if (!triggers) continue;
    for (const t of triggers) {
      if (t.event === event) {
        matches.push({ run, trigger: t as TriggerSpec<unknown> });
      }
    }
  }
  return matches;
};
