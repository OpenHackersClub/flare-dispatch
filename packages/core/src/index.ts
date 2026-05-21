// @flare-dispatch/core — public API.
//
// The DSL a run author builds against: the run frame (`defineRun`, `step`),
// the six capability namespaces, and the tagged error types. Primitives — the
// reusable compositions built on these capabilities — are a separate entry
// point so the layer boundary stays visible:
//
//   import { defineRun, step, sandbox } from "@flare-dispatch/core";
//   import { workspace, sharded }       from "@flare-dispatch/core/primitives";
//
// Spec: specs/03-dsl.md.

// --- Run frame ---------------------------------------------------------------
export {
  defineRun,
  type Run,
  type RunSpec,
  type RunLimits,
  type TriggerSpec,
  type ScheduleSpec,
  type ScheduleContext,
  type WebhookPayload,
} from "./define-run";
export { step, runEffect, type StepOpts } from "./step";
export { type RunContext } from "./context";

// --- Capabilities ------------------------------------------------------------
export {
  sandbox,
  Sandbox,
  type SandboxService,
  type Container,
  type DetachedHandle,
  type ExecResult,
  type ExecOpts,
} from "./services/sandbox";
export {
  browser,
  Browser,
  type BrowserService,
  type Page,
  type CDPSession,
} from "./services/browser";
export { cache, Cache, type CacheService } from "./services/cache";
export {
  artifact,
  Artifact,
  type ArtifactService,
  type ArtifactInfo,
} from "./services/artifact";
export {
  io,
  IO,
  type IOService,
  type LogLevel,
  type PriorExecution,
} from "./services/io";
export { config, Config, type ConfigService } from "./services/config";
export {
  github,
  Github,
  type GithubService,
  type RepoRef,
  type PullRequestRef,
} from "./services/github";
export {
  checks,
  Checks,
  type ChecksService,
  type CheckConclusion,
  type CheckOutput,
} from "./services/checks";
export {
  Executions,
  type ExecutionsService,
  type ExecutionRecord,
  type StepRecord,
  type StepStatus,
} from "./services/executions";
export {
  StepRunner,
  type StepRunnerService,
} from "./services/step-runner";

// --- Errors ------------------------------------------------------------------
export * from "./errors";
