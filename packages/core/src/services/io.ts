// @flare-dispatch/core — the `io` capability (non-deterministic primitives).
//
// Effect-friendly access to time, UUIDs, env, sleep, structured logging, and
// prior-execution metadata. Must be used instead of `Date.now()` /
// `crypto.randomUUID()` / `process.env` so Workflow step replay is
// deterministic.
//
// Spec: specs/03-dsl.md § io.

import { Context, type Duration, Effect, type Option, type Schema } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The most recent terminal execution in a run's semantic family. */
export type PriorExecution<O> = {
  readonly executionId: string;
  readonly sha: string;
  readonly output: O;
  readonly finishedAt: number; // epoch ms
};

export interface IOService {
  readonly now: Effect.Effect<number>;
  readonly uuid: Effect.Effect<string>;
  readonly env: (key: string) => Effect.Effect<string | undefined>;
  readonly sleep: (d: Duration.Duration | string) => Effect.Effect<void>;
  readonly log: (
    level: LogLevel,
    msg: string,
    attrs?: Record<string, unknown>,
  ) => Effect.Effect<void>;
  readonly priorExecution: <O>(opts: {
    family: string;
    outputSchema: Schema.Schema<O, unknown>;
  }) => Effect.Effect<Option.Option<PriorExecution<O>>>;
}

export class IO extends Context.Tag("@flare-dispatch/core/IO")<IO, IOService>() {}

export const io = {
  now: Effect.flatMap(IO, (s) => s.now),
  uuid: Effect.flatMap(IO, (s) => s.uuid),
  env: (key: string) => Effect.flatMap(IO, (s) => s.env(key)),
  sleep: (d: Duration.Duration | string) => Effect.flatMap(IO, (s) => s.sleep(d)),
  log: (level: LogLevel, msg: string, attrs?: Record<string, unknown>) =>
    Effect.flatMap(IO, (s) => s.log(level, msg, attrs)),
  priorExecution: <O>(opts: {
    family: string;
    outputSchema: Schema.Schema<O, unknown>;
  }) => Effect.flatMap(IO, (s) => s.priorExecution(opts)),
} as const;
