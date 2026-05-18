// FlareDispatch Dispatcher — the run registry.
//
// A name → `Run` map the routes resolve a dispatched run against. `RunWorkflow`
// (workflow.ts) keeps its own one-entry copy; this is the Dispatcher-side
// twin the `/v1/dispatch/:run` route uses to (a) 404 an unknown run and (b)
// Schema-validate `inputs` against the named run's `inputs` schema *before*
// instantiating the Workflow. `/health` lists `runNames()`.
//
// V0 ships one run (`offload-test`); each new run slots in as another entry.

import type { Run } from "@flare-dispatch/core";
import { offloadTest } from "@flare-dispatch/runs";

/** name → Run. The single seam new runs are registered through. */
export const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
};

/** Resolve a run by name; `undefined` for an unknown run (→ 404). */
export const lookupRun = (name: string): Run<unknown, unknown> | undefined =>
  RUN_REGISTRY[name];

/** The registered run names — sorted for a stable `/health` response. */
export const runNames = (): readonly string[] =>
  Object.keys(RUN_REGISTRY).sort();
