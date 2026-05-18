// Recipe: sharded test matrix — the `matrix-fanout` Run
//
// The typed Run that ./ci.yml dispatches. Runs the same command across N
// shards — one container per shard, all in parallel — and is green only if
// every shard passes. Each shard receives SHARD_INDEX / SHARD_TOTAL in its
// environment so the command can split its own work.
//
// This recipe rides on two primitives — `sharded` (count-and-index fan-out)
// and `workspace` (acquire + clone) — so the body is just "exec the command
// for this shard". See specs/03-dsl.md § Primitives.
//
// This is the shipped `matrix-fanout` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 2. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, artifact } from "@flare-dispatch/core";
import { sharded, workspace } from "@flare-dispatch/core/primitives";

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
      // `sharded` fans the command across N shards, handing each its
      // { index, total }; `workspace` does the per-shard container + clone.
      const shardResults = yield* step("run-shards", () =>
        sharded({
          count: input.shards,
          body: ({ index, total }) =>
            Effect.gen(function* () {
              const { container, dir } = yield* workspace({
                repo: input.repo,
                sha: input.sha,
                image: input.image,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: {
                  SHARD_INDEX: String(index),
                  SHARD_TOTAL: String(total),
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
        }),
      );

      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      return { passed: shardResults.length - failed, failed, shardResults };
    }),
});
