// @flare-dispatch/runtime-cf — CFRuntimeLive: the composed live runtime Layer.
//
// `Layer.mergeAll` of every capability Layer, wired to the real Cloudflare
// bindings — the production counterpart of `@flare-dispatch/core/testing`'s
// `CFRuntimeTest`. A run Effect provided this Layer executes against live D1 /
// R2 / Containers / Workflows. specs/03-dsl.md § Layers sketches `CFRuntimeLive`
// as a static value; in practice it is per-execution — the D1 `executions`
// row, the R2 artifact prefix, and the `StepRunner`'s `WorkflowStep` are all
// execution-scoped — so it is built by `makeCFRuntimeLive` from the dispatch
// event inside `RunWorkflow.run`.
//
// Layer composition note: `StepRunnerCloudflare` depends on `Executions` + `IO`
// (it records the step lifecycle), so its Layer is `Layer.provide`d those two
// — exactly how `CFRuntimeTest` wires `StepRunnerInline`.
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4.

import { type Sandbox } from "@cloudflare/sandbox";
import { Layer } from "effect";
import type { RunContext } from "@flare-dispatch/core";
import { makeR2ArtifactLive } from "./artifact-r2";
import {
  type BrowserRenderingConfig,
  makeBrowserRenderingLive,
} from "./browser-cf";
import { makeCacheR2Live } from "./cache-r2";
import {
  type ChecksGithubConfig,
  makeChecksGithubLive,
} from "./checks-github";
import { makeConfigKvLive } from "./config-kv";
import { BrowserDeferred, ConfigDeferred, GithubDeferred } from "./deferred";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { makeIOLive } from "./io-live";
import { makeSandboxCloudflareLive } from "./sandbox-cf";
import { makeStepRunnerCloudflare } from "./step-runner-cf";

/** The minimal `WorkflowStep` surface `StepRunnerCloudflare` needs. */
type WorkflowStepLike = {
  readonly do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
};

/** Everything `makeCFRuntimeLive` needs to wire the per-execution runtime. */
export type CFRuntimeLiveOptions = {
  /** D1 binding — `env.RUNS_METADATA`. */
  readonly db: D1Database;
  /** R2 binding — `env.RUNS_STORAGE`. */
  readonly bucket: R2Bucket;
  /** Containers binding — `env.RUNS_SANDBOX`. */
  readonly sandboxNs: DurableObjectNamespace<Sandbox>;
  /** The `step` argument from `WorkflowEntrypoint.run`. */
  readonly workflowStep: WorkflowStepLike;
  /** This execution's ULID — namespaces D1 rows, R2 keys, the sandbox id. */
  readonly executionId: string;
  /** repo/ref/sha/input the `executions` row requires. */
  readonly execution: ExecutionContext;
  /**
   * GitHub App credentials + installation id for the `Checks` capability.
   * `undefined` (no `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` secret, or a
   * dispatch with no `installation_id`) selects the no-op `Checks` Layer —
   * the execution still runs, only the PR check-run is skipped.
   */
  readonly checks?: ChecksGithubConfig;
  /**
   * KV binding for the `config` capability (`env.CONFIG_KV`). `undefined` —
   * a deploy with no `CONFIG_KV` namespace — selects the dying `Config` stub:
   * a run that reads config fails loudly rather than silently seeing every
   * key as unset. Present, the `loadSecrets` primitive can resolve credentials.
   */
  readonly configKv?: KVNamespace;
  /**
   * Browser Rendering connect config for the `browser` capability
   * (`BROWSER_CDP_*` Worker secrets). `undefined` — a deploy with no Browser
   * Rendering configured — selects the dying `Browser` stub: a browser run
   * (`cdp-acceptance`) fails loudly. Non-browser runs never touch the Tag.
   */
  readonly browser?: BrowserRenderingConfig;
};

/**
 * Build the complete live `RunContext` Layer for one execution. All capability
 * services are merged; `StepRunnerCloudflare` is provided its `Executions` +
 * `IO` dependencies from the same merge.
 */
export const makeCFRuntimeLive = (
  opts: CFRuntimeLiveOptions,
): Layer.Layer<RunContext> => {
  const io = makeIOLive({
    db: opts.db,
    currentExecutionId: opts.executionId,
  });
  const executions = makeD1ExecutionsLive(opts.db, opts.execution);
  const artifact = makeR2ArtifactLive(opts.bucket, opts.executionId);
  const sandbox = makeSandboxCloudflareLive(
    opts.sandboxNs,
    opts.bucket,
    opts.executionId,
  );
  const stepRunner = makeStepRunnerCloudflare(
    opts.workflowStep,
    opts.executionId,
  );
  const checks = makeChecksGithubLive(opts.checks);
  // The cache archive key is scoped by repo so two repos with an identical
  // lockfile hash cannot collide (cross-repo cache poisoning).
  const cache = makeCacheR2Live(
    opts.bucket,
    opts.sandboxNs,
    opts.execution.repo,
  );
  // `Config` is live when the `CONFIG_KV` binding is present; absent, the
  // dying stub keeps a config-reading run from silently mis-behaving.
  const config =
    opts.configKv === undefined
      ? ConfigDeferred
      : makeConfigKvLive(opts.configKv);
  // `Browser` is live when Browser Rendering is configured; absent, the dying
  // stub keeps a browser run from silently mis-behaving.
  const browser =
    opts.browser === undefined
      ? BrowserDeferred
      : makeBrowserRenderingLive(opts.browser);

  return Layer.mergeAll(
    sandbox,
    browser,
    cache,
    artifact,
    io,
    config,
    checks,
    GithubDeferred,
    executions,
    // StepRunnerCloudflare needs Executions + IO — supply them from the merge.
    Layer.provide(stepRunner, Layer.merge(executions, io)),
  );
};
