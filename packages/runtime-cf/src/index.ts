// @flare-dispatch/runtime-cf — public API.
//
// The live Cloudflare-binding runtime: the Layers that back the
// `@flare-dispatch/core` capability Tags with real D1 / R2 / Containers /
// Workflows. The Dispatcher's `RunWorkflow` builds `makeCFRuntimeLive(...)`
// from a dispatch event and provides it to a run Effect.
//
//   import { makeCFRuntimeLive } from "@flare-dispatch/runtime-cf";
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4.

// --- The composed runtime ----------------------------------------------------
export {
  makeCFRuntimeLive,
  type CFRuntimeLiveOptions,
} from "./runtime";

// --- Individual capability Layers (also exported for targeted tests) ---------
export { IOLive, makeIOLive } from "./io-live";
export {
  makeD1ExecutionsLive,
  type ExecutionContext,
} from "./executions-d1";
export { makeR2ArtifactLive } from "./artifact-r2";
export { makeSandboxCloudflareLive } from "./sandbox-cf";
export { makeStepRunnerCloudflare } from "./step-runner-cf";
export {
  makeChecksGithubLive,
  NOOP_CHECK_RUN_ID,
  type ChecksGithubConfig,
} from "./checks-github";
export {
  BrowserDeferred,
  CacheDeferred,
  ConfigDeferred,
} from "./deferred";

// --- The Sandbox Durable Object class ----------------------------------------
// Re-exported so `apps/dispatcher` can `extends` it for the `RUNS_SANDBOX`
// container binding without a direct `@cloudflare/sandbox` import.
export { Sandbox as SandboxContainer } from "@cloudflare/sandbox";
