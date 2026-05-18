// @flare-dispatch/runs — the FlareDispatch starter run catalog.
//
// V0 ships a single run, `offload-test`. The Dispatcher's `RunWorkflow`
// resolves a dispatched run by name against this module's exports — a
// one-entry registry today, the seam each new run slots into.
//
// Spec: specs/02-runs.md, specs/pm/plan.md § PR3 + § PR4.

export { offloadTest } from "./offload-test";
