// `matrix-fanout` — same command across N shards in parallel.
//
// One container per shard, all in parallel via the `sharded` primitive. Each
// shard receives SHARD_INDEX / SHARD_TOTAL in its env so the command can split
// its own work. The run is green only if every shard exits 0.
//
// Contract per specs/02-runs.md § 2. Rides on `sharded` + `workspace` so the
// body is "exec the command for this shard, upload its log."
//
// The recipe at recipes/test-matrix/matrix-fanout.run.ts re-exports this run
// so the recipe directory stays self-contained for copy-paste while there is
// still one canonical implementation the Dispatcher registers.

import { Effect, Schema } from "effect";
import { artifact, defineRun, sandbox, step } from "@flare-dispatch/core";
import { sharded, workspace } from "@flare-dispatch/core/primitives";

const MatrixFanoutInput = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  command: Schema.String,
  shards: Schema.Number,
  image: Schema.optional(Schema.String),
});

const MatrixFanoutOutput = Schema.Struct({
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
  inputs: MatrixFanoutInput,
  outputs: MatrixFanoutOutput,
  limits: { maxDurationSec: 1800, maxConcurrency: 8 },

  run: (input) =>
    Effect.gen(function* () {
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
      return {
        passed: shardResults.length - failed,
        failed,
        shardResults,
      };
    }),
});
