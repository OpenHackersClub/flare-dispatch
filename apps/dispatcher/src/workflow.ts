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
// writer. The GitHub check-run callback — the other half of `finalize` —
// lands with `ChecksGithubLive` in PR6.
//
// Spec: specs/01-architecture.md § Workflow Engine + § Per-execution lifecycle,
//       specs/pm/plan.md § PR4.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Exit, Schema } from "effect";
import { Executions, type Run } from "@flare-dispatch/core";
import { makeCFRuntimeLive } from "@flare-dispatch/runtime-cf";
import { offloadTest } from "@flare-dispatch/runs";
import type { Env } from "./env";

/**
 * The V0 run registry — a one-entry map from run name to its `Run` value.
 * `RunWorkflow` looks a dispatched run up here; an unknown name fails the
 * execution. Each new run added in V1+ slots in as another entry.
 */
const RUN_REGISTRY: Record<string, Run<unknown, unknown>> = {
  [offloadTest.name]: offloadTest as Run<unknown, unknown>,
};

/** The repo/ref/sha context a dispatch carries — `04-gha-integration § body`. */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, { default: () => "refs/heads/main" }),
  sha: Schema.String,
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
  /** repo / ref / sha — the `executions` row context. */
  github: GithubContext,
  /** the run inputs, decoded per-run against `run.inputs`. */
  inputs: Schema.Unknown,
});
type DispatchPayload = Schema.Schema.Type<typeof DispatchPayload>;

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

    // Build the per-execution live runtime: D1 + R2 + Containers, with
    // `StepRunner` bound to *this* Workflow's `step` so each `step(...)` in the
    // run body is a real durable `WorkflowStep.do(...)` checkpoint.
    const runtime = makeCFRuntimeLive({
      db: this.env.RUNS_METADATA,
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
    });

    // The execution program: open the `executions` row, run the run Effect,
    // then write the terminal status from its Exit — the `finalize` boundary.
    // A run-level failure is *data* (a recorded `failure` row + the check-run
    // verdict in PR6), never a thrown Workflow infra error — so the run Effect
    // is taken to an `Exit` and its status mapped, not propagated as a throw.
    const program = Effect.gen(function* () {
      const executions = yield* Executions;
      const startedAt = yield* Effect.sync(() => Date.now());
      yield* executions.startExecution({
        id: payload.executionId,
        run: payload.run,
        startedAt,
      });

      const exit = yield* Effect.exit(run.run(input));
      const completedAt = yield* Effect.sync(() => Date.now());

      yield* executions.finishExecution({
        id: payload.executionId,
        completedAt,
        status: Exit.match(exit, {
          onSuccess: () => "success" as const,
          onFailure: () => "failure" as const,
        }),
      });
    });

    await Effect.runPromise(program.pipe(Effect.provide(runtime)));
  }
}
