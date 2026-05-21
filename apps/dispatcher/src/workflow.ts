// FlareDispatch Dispatcher — RunWorkflow: the V0 Workflow class.
//
// `RunWorkflow extends WorkflowEntrypoint` is the single Workflow bound as
// `RUNS_WORKFLOW`. Its `run(event, step)` is the bridge between CF Workflows
// and the Effect-TS run DSL:
//
//   1. resolve the run named in the dispatch event against the run registry
//      (V0: a one-entry registry → `offloadTest`);
//   2. decode the event's `inputs` against the run's `inputs` Schema;
//   3. build the per-execution `CFRuntimeLive` Layer, binding `StepRunner` to
//      the live CF `step` argument so every `step(...)` is a durable checkpoint;
//   4. run `run.run(input)` under an Effect runtime;
//   5. write the terminal `executions` status — the `finalize` boundary that
//      `offload-test` deliberately leaves to the Workflow (see runs/offload-
//      test.ts header note 1).
//
// The execution-row lifecycle (`startExecution` / `finishExecution`) is owned
// here, not in the run body: the run records its *steps*; the Workflow records
// the *execution*. Both go through the `ExecutionsService` so D1 has one
// writer.
//
// --- The GitHub check-run callback (PR6) -------------------------------------
//
// The other half of `finalize` is the GitHub check-run — the actual PR signal.
// `RunWorkflow` opens an `in_progress` check-run when the execution starts and
// completes it (`success` for a green run Exit, `failure` for red) when it
// finishes, via the `Checks` capability backed by `ChecksGithubLive`.
//
//   * The App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) come from
//     `env`; the installation id rides in the dispatch payload's
//     `github.installation_id` (PR5's dispatch route fills it in). When any of
//     the three is absent — local dev without secrets, or a dispatch with no
//     installation — `makeCFRuntimeLive` selects the *no-op* `Checks` Layer:
//     the execution runs to completion and records its D1 rows, only the PR
//     check-run is skipped. A missing check-run never fails an execution.
//   * The GitHub-assigned check-run id is persisted onto the `executions` row's
//     `check_run_id` column. The core `ExecutionsService` interface is
//     run-agnostic and carries no check-run method, so this single UPDATE is
//     issued directly against the D1 binding the Workflow already holds —
//     `RunWorkflow` owns the execution row, this is part of that ownership.
//
// Spec: specs/01-architecture.md § Workflow Engine + § Per-execution lifecycle,
//       specs/04-gha-integration.md § Check-runs callback,
//       specs/pm/plan.md § PR4 + § PR6.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Exit, Schema } from "effect";
import { Checks, Executions, type Run } from "@flare-dispatch/core";
import {
  type BrowserRenderingConfig,
  type ChecksGithubConfig,
  makeCFRuntimeLive,
} from "@flare-dispatch/runtime-cf";
import {
  cdpAcceptance,
  deploySmoke,
  matrixFanout,
  offloadTest,
  playwrightE2E,
  productDemo,
} from "@flare-dispatch/runs";
import type { Env } from "./env";

/**
 * The run registry — a map from run name to its `Run` value. `RunWorkflow`
 * looks a dispatched run up here; an unknown name fails the execution. Each
 * new run slots in as another entry — `offload-test` (V0), `cdp-acceptance`
 * (V2 browser acceptance, PR9).
 */
const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
  [cdpAcceptance.name]: cdpAcceptance as Run<unknown, unknown>,
  [deploySmoke.name]: deploySmoke as Run<unknown, unknown>,
  [matrixFanout.name]: matrixFanout as Run<unknown, unknown>,
  [playwrightE2E.name]: playwrightE2E as Run<unknown, unknown>,
  [productDemo.name]: productDemo as Run<unknown, unknown>,
};

/** The repo/ref/sha context a dispatch carries — `04-gha-integration § body`. */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, { default: () => "refs/heads/main" }),
  sha: Schema.String,
  /**
   * The GitHub App installation id for the repo — needed to mint the
   * installation token the check-run callback authenticates with. Optional:
   * absent in local dev / direct dispatches without an installed App, in which
   * case the runtime degrades to the no-op `Checks` Layer. PR5's dispatch route
   * fills this in from the request body.
   */
  installation_id: Schema.optional(Schema.Number),
});

/**
 * The Workflow event payload — the dispatch body the Dispatcher's
 * `/v1/dispatch/:run` route forwards into `RUNS_WORKFLOW.create(...)`. PR5
 * owns that route; PR4 pins the shape `RunWorkflow` decodes.
 */
const DispatchPayload = Schema.Struct({
  /** the ULID assigned to this execution. */
  executionId: Schema.String,
  /** which run to execute — keyed into `RUN_REGISTRY`. */
  run: Schema.String,
  /** repo / ref / sha / installation — the `executions` row + check-run context. */
  github: GithubContext,
  /** the run inputs, decoded per-run against `run.inputs`. */
  inputs: Schema.Unknown,
});
type DispatchPayload = Schema.Schema.Type<typeof DispatchPayload>;

/**
 * Resolve the `Checks` Layer config from `env` + the dispatch payload, or
 * `undefined` when any of the three required pieces (App id, PEM, installation
 * id) is absent — `undefined` selects the no-op `Checks` Layer.
 */
const resolveChecksConfig = (
  env: Env,
  github: DispatchPayload["github"],
): ChecksGithubConfig | undefined => {
  if (
    env.GITHUB_APP_ID === undefined ||
    env.GITHUB_APP_PRIVATE_KEY === undefined ||
    github.installation_id === undefined
  ) {
    return undefined;
  }
  return {
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    installationId: github.installation_id,
  };
};

/**
 * Resolve the `Browser` Layer config from `env`, or `undefined` when Browser
 * Rendering is not configured — `undefined` selects the dying `Browser` stub.
 * Only browser runs (`cdp-acceptance`) touch the Tag; others are unaffected.
 */
const resolveBrowserConfig = (env: Env): BrowserRenderingConfig | undefined =>
  env.BROWSER_CDP_CONNECT_URL === undefined
    ? undefined
    : {
        connectUrl: env.BROWSER_CDP_CONNECT_URL,
        apiToken: env.BROWSER_CDP_API_TOKEN,
      };

export class RunWorkflow extends WorkflowEntrypoint<Env> {
  override async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<void> {
    // Decode the dispatch payload — a malformed event is a hard failure.
    const payload: DispatchPayload = Schema.decodeUnknownSync(DispatchPayload)(
      event.payload,
    );

    const run = RUN_REGISTRY[payload.run];
    if (run === undefined) {
      throw new Error(`RunWorkflow: unknown run "${payload.run}"`);
    }

    // Decode the run inputs against the run's own Schema — a contract mismatch
    // fails before any container boots.
    const input = Schema.decodeUnknownSync(run.inputs)(payload.inputs);

    // Build the per-execution live runtime: D1 + R2 + Containers + Checks, with
    // `StepRunner` bound to *this* Workflow's `step` so each `step(...)` in the
    // run body is a real durable `WorkflowStep.do(...)` checkpoint.
    const db = this.env.RUNS_METADATA;
    const checkRunName = `flare-dispatch/${payload.run}`;
    const runtime = makeCFRuntimeLive({
      db,
      bucket: this.env.RUNS_STORAGE,
      sandboxNs: this.env.RUNS_SANDBOX,
      workflowStep: step,
      executionId: payload.executionId,
      execution: {
        repo: payload.github.repo,
        ref: payload.github.ref,
        sha: payload.github.sha,
        input,
      },
      checks: resolveChecksConfig(this.env, payload.github),
      configKv: this.env.CONFIG_KV,
      browser: resolveBrowserConfig(this.env),
    });

    // The execution program — the `finalize` boundary:
    //   1. open the `executions` row;
    //   2. open the `in_progress` check-run, persist its id on the row;
    //   3. run the run Effect to an `Exit` (a run-level failure is *data*, a
    //      recorded `failure` row + a `failure` check-run conclusion — never a
    //      thrown Workflow infra error);
    //   4. write the terminal `executions` status + complete the check-run.
    const program = Effect.gen(function* () {
      const executions = yield* Executions;
      const checks = yield* Checks;

      const startedAt = yield* Effect.sync(() => Date.now());
      yield* executions.startExecution({
        id: payload.executionId,
        run: payload.run,
        startedAt,
      });

      // Open the check-run (`in_progress`). With no App config this resolves
      // to the no-op sentinel id and posts nothing.
      const checkRunId = yield* checks.create({
        repo: payload.github.repo,
        sha: payload.github.sha,
        name: checkRunName,
        output: {
          title: checkRunName,
          summary: `Execution \`${payload.executionId}\` started.`,
        },
      });
      // Persist the GitHub check-run id onto the `executions` row.
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE executions SET check_run_id = ? WHERE id = ?`)
          .bind(checkRunId, payload.executionId)
          .run(),
      ).pipe(Effect.orDie);

      const exit = yield* Effect.exit(run.run(input));
      const completedAt = yield* Effect.sync(() => Date.now());

      const status = Exit.match(exit, {
        onSuccess: () => "success" as const,
        onFailure: () => "failure" as const,
      });

      yield* executions.finishExecution({
        id: payload.executionId,
        completedAt,
        status,
      });

      // Complete the check-run with the run's verdict.
      yield* checks.update({
        repo: payload.github.repo,
        checkRunId,
        conclusion: status,
        output: {
          title: checkRunName,
          summary: Exit.match(exit, {
            onSuccess: () => `✓ ${payload.run} — execution succeeded.`,
            onFailure: () => `✗ ${payload.run} — execution failed.`,
          }),
        },
      });
    });

    await Effect.runPromise(program.pipe(Effect.provide(runtime)));
  }
}
