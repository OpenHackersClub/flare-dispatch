// @flare-dispatch/core — StepRunnerInline: the test/dev step runner.
//
// The non-CF `StepRunner` binding: runs each `step()` body Effect *inline* (no
// CF Workflow, no `WorkflowStep.do`, no Promise boundary) and records the step
// lifecycle into `ExecutionsService` — one `startStep` at entry, one
// `finishStep` at exit. PR4's `StepRunnerCloudflare` is the production
// counterpart that backs the same seam with `WorkflowStep.do`.
//
// Failure handling — the contract the acceptance criteria pin:
//   * a body that fails with a tagged error has its `finishStep` recorded with
//     `status: "failure"` and `errorTag` set to the failure's `_tag`;
//   * the original failure is then re-failed into the typed `E` channel — it
//     never escapes as a throw. Recording is a side effect on the way out, not
//     a catch.
//
// `errorTag` is read via `Cause.failureOption` + `Option.match` — never a raw
// `._tag` branch (CLAUDE.md § Effect-TS).
//
// Spec: specs/03-dsl.md § step, specs/pm/plan.md § PR2.

import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { ApprovalTimedOut, EventPayloadInvalid } from "../errors";
import { Executions, type ExecutionsService } from "../services/executions";
import { IO, type IOService } from "../services/io";
import { StepRunner, type StepRunnerService } from "../services/step-runner";

/** Default execution id used when a test does not supply one. */
export const DEFAULT_TEST_EXECUTION_ID = "01TEST00000000000000000000";

/**
 * The in-memory event source `StepRunnerInline.waitForEvent` resolves against.
 * Tests pre-populate this with `enqueueInlineEvent`; an empty queue causes
 * `waitForEvent` to fail with `ApprovalTimedOut` immediately (the test runner
 * does not actually sleep — that's the point of being a fake).
 */
export type InlineEventQueue = Map<string, unknown[]>;

/** Push an event payload into the inline runner's queue for a given type. */
export const enqueueInlineEvent = (
  queue: InlineEventQueue,
  type: string,
  payload: unknown,
): void => {
  const arr = queue.get(type) ?? [];
  arr.push(payload);
  queue.set(type, arr);
};

/** Extract a tagged error's `_tag` from a Cause, without a raw `._tag` branch. */
const errorTagOf = (cause: Cause.Cause<unknown>): string | undefined =>
  Option.match(Cause.failureOption(cause), {
    onSome: (failure) => {
      const tag = (failure as { _tag?: unknown })._tag;
      return typeof tag === "string" ? tag : "UnknownError";
    },
    onNone: () => undefined,
  });

/**
 * Build a `StepRunner` Layer that runs step bodies inline and records the
 * lifecycle into `ExecutionsService`. Depends on `Executions` (the recorder)
 * and `IO` (deterministic timestamps), so the resulting Layer requires those.
 */
export const makeStepRunnerInline = (
  opts: { executionId?: string; eventQueue?: InlineEventQueue } = {},
): Layer.Layer<StepRunner, never, Executions | IO> => {
  const executionId = opts.executionId ?? DEFAULT_TEST_EXECUTION_ID;
  const events = opts.eventQueue ?? new Map<string, unknown[]>();

  return Layer.effect(
    StepRunner,
    Effect.gen(function* () {
      const executions: ExecutionsService = yield* Executions;
      const ioSvc: IOService = yield* IO;

      const service: StepRunnerService = {
        run: (name, body, stepOpts) =>
          Effect.gen(function* () {
            const startedAt = yield* ioSvc.now;
            yield* executions.startStep({
              executionId,
              name,
              startedAt,
              metadata: stepOpts?.metadata,
            });

            // Run the body to an Exit so failure is data, not control flow.
            const exit = yield* Effect.exit(body());
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
              onFailure: (cause) =>
                executions
                  .finishStep({
                    executionId,
                    name,
                    completedAt,
                    status: "failure",
                    errorTag: errorTagOf(cause),
                  })
                  // Re-fail with the original Cause: the typed failure stays
                  // in the `E` channel; nothing is thrown.
                  .pipe(Effect.andThen(Effect.failCause(cause))),
            });
          }),

        // Inline `waitForEvent` reads from the test-supplied event queue —
        // present payload → decode + return; empty queue → `ApprovalTimedOut`
        // immediately. The fake never sleeps; tests that want to assert the
        // timeout path call `waitForEvent` with no queued event.
        waitForEvent: <P, I>(
          _name: string,
          {
            type,
            timeout,
            payloadSchema,
          }: {
            type: string;
            timeout: Duration.Duration | string;
            payloadSchema: Schema.Schema<P, I>;
          },
        ): Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid> =>
          Effect.suspend((): Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid> => {
            const queue = events.get(type) ?? [];
            if (queue.length === 0) {
              const timeoutMs = Duration.toMillis(
                Duration.decode(timeout as Duration.DurationInput),
              );
              return Effect.fail(
                new ApprovalTimedOut({ eventName: type, timeoutMs }),
              );
            }
            const raw = queue.shift()!;
            events.set(type, queue);
            const decoded = Schema.decodeUnknownEither(payloadSchema)(raw);
            if (decoded._tag === "Left") {
              return Effect.fail(
                new EventPayloadInvalid({
                  eventName: type,
                  reason: "decode failed",
                }),
              );
            }
            return Effect.succeed(decoded.right);
          }),
      };

      return service;
    }),
  );
};

/** A ready-to-use inline `StepRunner` Layer with the default execution id. */
export const StepRunnerInline: Layer.Layer<
  StepRunner,
  never,
  Executions | IO
> = makeStepRunnerInline();
