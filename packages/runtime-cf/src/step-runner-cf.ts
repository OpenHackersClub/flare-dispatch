// @flare-dispatch/runtime-cf — StepRunnerCloudflare: the live step boundary.
//
// The production `StepRunner` binding — the CF counterpart to the test
// runtime's `StepRunnerInline`. It backs each `step(name, body, opts)` call
// with a real CF `WorkflowStep.do(name, ...)`, so the step is a durable,
// retryable Workflow checkpoint, and records the `ExecutionsService` lifecycle
// (one `startStep` at entry, one `finishStep` at exit).
//
// --- The runEffect / Workflows boundary, in one place ------------------------
//
// CF Workflows is imperative: `step.do(name, cb)` awaits `cb` as a Promise and
// treats a THROWN error as a step failure (so the platform records it and
// retries). Effect keeps errors in the typed `E` channel and never throws. The
// two are reconciled exactly as specs/03-dsl.md § The runEffect boundary shim
// prescribes:
//
//   1. The body Effect (`Effect<A, E, RunContext>`) has its ambient
//      `RunContext` provided — captured via `Effect.context()` — so it becomes
//      `Effect<A, E, never>`, runnable at the imperative boundary.
//   2. Inside the `step.do` callback, `runEffect` runs that Effect: on success
//      it returns `A`; on a typed failure it THROWS the failure (with the
//      Effect `Cause` attached as `.cause`) so Workflows fails+retries the step.
//   3. When `step.do`'s Promise settles, the runner converts back: success →
//      `Effect.succeed`; rejection → re-fail with the original `Cause` (read
//      off the thrown error) so the typed `E` is preserved end-to-end. A
//      rejection without an Effect `Cause` (an infra failure inside Workflows
//      itself) becomes a `StepFailed`.
//
// Net effect: a run author writes `yield* Effect.fail(...)` inside a step body
// and catches it with `Effect.catchTag` outside — the throw at the Workflow
// boundary is entirely internal to this runner.
//
// Spec: specs/03-dsl.md § step + § The runEffect boundary shim, plan § PR4.

import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  Executions,
  type ExecutionsService,
  IO,
  type IOService,
  runEffect,
  type RunContext,
  StepFailed,
  StepRunner,
  type StepRunnerService,
} from "@flare-dispatch/core";

/** The minimal `WorkflowStep` surface the runner needs — `do(name, cb)`. */
type WorkflowStepLike = {
  readonly do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
};

/** A thrown error carrying an Effect `Cause` — produced by `runEffect`. */
type CausalError = { readonly cause?: unknown };

/** Extract the Effect `Cause` `runEffect` attached to a thrown failure. */
const causeOf = (error: unknown): Cause.Cause<unknown> | undefined => {
  const candidate = (error as CausalError | null | undefined)?.cause;
  return Cause.isCause(candidate) ? candidate : undefined;
};

/** A tagged error's `_tag` from a Cause, via `Option.match` — no raw `._tag`. */
const errorTagOf = (
  cause: Cause.Cause<unknown> | undefined,
): string | undefined =>
  cause === undefined
    ? "StepFailed"
    : Option.match(Cause.failureOption(cause), {
        onSome: (failure) => {
          const tag = (failure as { _tag?: unknown })._tag;
          return typeof tag === "string" ? tag : "UnknownError";
        },
        onNone: () => undefined,
      });

/**
 * Build a `StepRunner` Layer backed by a CF `WorkflowStep`. Depends on
 * `Executions` (lifecycle records) and `IO` (deterministic step timestamps),
 * so the resulting Layer requires both.
 *
 * @param workflowStep  the `step` argument passed to `WorkflowEntrypoint.run`.
 * @param executionId   the execution the `steps` rows are recorded under.
 */
export const makeStepRunnerCloudflare = (
  workflowStep: WorkflowStepLike,
  executionId: string,
): Layer.Layer<StepRunner, never, Executions | IO> =>
  Layer.effect(
    StepRunner,
    Effect.gen(function* () {
      const executions: ExecutionsService = yield* Executions;
      const ioSvc: IOService = yield* IO;

      const service: StepRunnerService = {
        run: (name, body, stepOpts) =>
          Effect.gen(function* () {
            // Capture the ambient RunContext so the body — which still needs
            // its capabilities — can be run at the imperative `step.do`
            // boundary, where the Effect's `R` must be `never`.
            const context = yield* Effect.context<RunContext>();

            const startedAt = yield* ioSvc.now;
            yield* executions.startStep({
              executionId,
              name,
              startedAt,
              metadata: stepOpts?.metadata,
            });

            // Drive the body through the durable Workflow checkpoint. The
            // `step.do` callback runs the (context-provided) body via the
            // `runEffect` shim — which throws a typed failure so Workflows
            // records+retries it. `Effect.tryPromise` brings the settled
            // Promise back: a rejection lands in the failure channel as
            // `{ error }`, so failure is data the match below branches on.
            const exit = yield* Effect.exit(
              Effect.tryPromise({
                try: () =>
                  workflowStep.do(name, () =>
                    runEffect(Effect.provide(body(), context)),
                  ),
                catch: (error): { readonly error: unknown } => ({ error }),
              }),
            );

            const completedAt = yield* ioSvc.now;

            return yield* Exit.match(exit, {
              onSuccess: (value) =>
                executions
                  .finishStep({
                    executionId,
                    name,
                    completedAt,
                    status: "success",
                  })
                  .pipe(Effect.as(value)),

              onFailure: (failCause) => {
                // `tryPromise`'s `catch` wrapped the rejection as `{ error }`
                // in the failure channel — recover the real thrown error.
                const thrown = Option.match(
                  Cause.failureOption(failCause),
                  {
                    onSome: (wrapped) =>
                      (wrapped as { error: unknown }).error,
                    onNone: () => undefined,
                  },
                );

                // The Effect Cause `runEffect` preserved on the thrown error:
                // re-failing with it keeps the typed `E` channel intact across
                // the Workflow boundary. No Cause ⇒ a Workflows-internal infra
                // failure (or `tryPromise` defect) ⇒ surface as `StepFailed`.
                const original = causeOf(thrown);
                const reFail =
                  original === undefined
                    ? Effect.fail(
                        new StepFailed({
                          step: name,
                          cause: thrown ?? failCause,
                        }),
                      )
                    : Effect.failCause(original as Cause.Cause<never>);

                return executions
                  .finishStep({
                    executionId,
                    name,
                    completedAt,
                    status: "failure",
                    errorTag: errorTagOf(original),
                  })
                  .pipe(Effect.andThen(reFail));
              },
            });
          }),
      };

      return service;
    }),
  );
