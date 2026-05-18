// @flare-dispatch/core — step: the durable checkpoint boundary.
//
// `step(name, body)` wraps an Effect in a CF Workflow step — durable across
// Worker restarts, retried by the platform, individually logged. The binding
// to `WorkflowStep.do(...)` is supplied by the runtime (the Dispatcher's
// workflow.ts); `step` here is the DSL surface that binding satisfies.
//
// The `runEffect` shim reconciles Workflows (imperative — throws to fail a
// step) with Effect (typed E channel — never throws). Inside a step body the
// Effect rules apply; at the boundary the shim throws a typed failure so
// Workflows records it in its retry telemetry.
//
// Spec: specs/03-dsl.md § step.

import { Cause, type Duration, Effect, Exit, Option, type Schema } from "effect";
import type { RunContext } from "./context";
import type {
  ApprovalTimedOut,
  EventPayloadInvalid,
  StepFailed,
} from "./errors";

/**
 * Execute an Effect at the Workflow step boundary, rethrowing typed failures.
 *
 * The Effect must already have its `RunContext` provided by the runtime Layer
 * (`R = never`) before it reaches the boundary — `runEffect` is the imperative
 * shim, not the place capabilities are supplied.
 */
export const runEffect = <A, E>(eff: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(eff).then((exit) =>
    Exit.match(exit, {
      onSuccess: (a) => a,
      onFailure: (cause) => {
        // Some => a typed run failure; None => a defect, rendered from the
        // pretty Cause. Branch the Option — never read `._tag` raw.
        const err = Option.match(Cause.failureOption(cause), {
          onSome: (failure) => failure as unknown as Error,
          onNone: () => new Error(Cause.pretty(cause)),
        });
        (err as { cause?: unknown }).cause = cause;
        throw err;
      },
    }),
  );

export type StepOpts = {
  readonly retries?: number; // platform-level retry on infra failure
  readonly timeoutSec?: number;
  readonly metadata?: Record<string, unknown>; // attached to the D1 step record
};

/**
 * Wrap an Effect in a Workflow checkpoint. Step names must be unique within a
 * run — they are the dedup key for checkpoint replay. `step.waitForEvent`
 * hibernates the Workflow until an external event arrives, or times out.
 */
export declare const step: {
  <A, E>(
    name: string,
    body: () => Effect.Effect<A, E, RunContext>,
    opts?: StepOpts,
  ): Effect.Effect<A, E | StepFailed, RunContext>;

  readonly waitForEvent: <P>(
    name: string,
    opts: {
      type: string;
      timeout: Duration.Duration | string;
      payloadSchema: Schema.Schema<P, unknown>;
    },
  ) => Effect.Effect<P, ApprovalTimedOut | EventPayloadInvalid, RunContext>;
};
