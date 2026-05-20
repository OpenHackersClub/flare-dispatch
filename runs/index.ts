// @flare-dispatch/runs — the FlareDispatch starter run catalog.
//
// The Dispatcher's `RunWorkflow` resolves a dispatched run by name against
// this module's exports — the seam each new run slots into. V0 shipped
// `offload-test`; PR9 adds `cdp-acceptance` (browser acceptance, V2); the
// Schedule-mode PR adds `daily-demo` (V3 — first cron-triggered run).
//
// Spec: specs/02-runs.md, specs/pm/plan.md § PR3 + § PR4 + § PR9 + § PR10.

export { offloadTest } from "./offload-test";
export { cdpAcceptance } from "./cdp-acceptance";
export { dailyDemo } from "./daily-demo";
