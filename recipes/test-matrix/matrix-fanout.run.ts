// Recipe: sharded test matrix — the `matrix-fanout` Run
//
// The typed Run that ./ci.yml dispatches. Runs the same command across N
// shards — one container per shard, all in parallel — and is green only if
// every shard passes. Each shard receives SHARD_INDEX / SHARD_TOTAL in its
// environment so the command can split its own work.
//
// This is the shipped `matrix-fanout` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 2. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, artifact } from "@flaredispatch/core";

const Input = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  command: Schema.String, // receives SHARD_INDEX, SHARD_TOTAL
  shards: Schema.Number, // 2..32
  image: Schema.optional(Schema.String),
});

const Output = Schema.Struct({
  passed: Schema.Number,
  failed: Schema.Number,
  shardResults: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      exitCode: Schema.Number,
      durationMs: Schema.Number,
      logUri: Schema.String,
    }),
  ),
});

export const matrixFanout = defineRun({
  name: "matrix-fanout",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 1800, maxConcurrency: 8 },

  run: (input) =>
    Effect.gen(function* () {
      const shardResults = yield* step("run-shards", () =>
        Effect.forEach(
          Array.from({ length: input.shards }, (_, i) => i + 1),
          (index) =>
            Effect.gen(function* () {
              const container = yield* sandbox.acquire({ image: input.image });
              const dir = yield* sandbox.git.clone({
                repo: input.repo,
                sha: input.sha,
                container,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: {
                  SHARD_INDEX: String(index),
                  SHARD_TOTAL: String(input.shards),
                },
                command: input.command,
              });
              const logUri = yield* artifact.upload({
                name: `shard-${index}.log`,
                path: exec.logPath,
                container,
              });
              return {
                index,
                exitCode: exec.exitCode,
                durationMs: exec.durationMs,
                logUri,
              };
            }),
          { concurrency: input.shards },
        ),
      );

      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      return { passed: shardResults.length - failed, failed, shardResults };
    }),
});
