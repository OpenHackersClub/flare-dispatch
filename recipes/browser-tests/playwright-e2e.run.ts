// Recipe: browser tests — the `playwright-e2e` Run
//
// The typed Run that ./ci.yml dispatches. Shards a Playwright suite with
// Playwright's native --shard flag — one container per shard, all in
// parallel — and uploads a report per shard.
//
// This recipe rides on two primitives — `sharded` (count-and-index fan-out)
// and `workspace` (acquire + clone + cached install) — so the body is just
// "run Playwright on this shard". See specs/03-dsl.md § Primitives.
//
// This is the shipped `playwright-e2e` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 3. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, artifact } from "@flare-dispatch/core";
import { sharded, workspace } from "@flare-dispatch/core/primitives";

const Input = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  baseURL: Schema.String,
  shards: Schema.optional(Schema.Number), // default 4
  project: Schema.optional(Schema.String), // Playwright project name
});

const Output = Schema.Struct({
  shards: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  shardResults: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      exitCode: Schema.Number,
      reportUri: Schema.String,
    }),
  ),
});

export const playwrightE2E = defineRun({
  name: "playwright-e2e",
  version: "1.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-playwright:latest",
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 2400, maxConcurrency: 8, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      const shards = input.shards ?? 4;
      const projectArg = input.project ? ["--project", input.project] : [];

      // One container per shard, all in parallel. `sharded` hands each shard
      // its { index, total }; `workspace` does the per-shard checkout +
      // cached install. The suite's Playwright config points at CF Browser
      // Rendering — `requiresBrowser` declares the binding.
      const shardResults = yield* step("run-shards", () =>
        sharded({
          count: shards,
          body: ({ index, total }) =>
            Effect.gen(function* () {
              const { container, dir } = yield* workspace({
                repo: input.repo,
                sha: input.sha,
                install: true,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: { BASE_URL: input.baseURL },
                command: [
                  "pnpm", "exec", "playwright", "test",
                  "--shard", `${index}/${total}`,
                  ...projectArg,
                ],
              });
              const reportUri = yield* artifact.upload({
                name: `playwright-report-${index}`,
                path: `${dir}/playwright-report/`,
                container,
                signedUrlTTL: "30 days",
              });
              return { index, exitCode: exec.exitCode, reportUri };
            }),
        }),
      );

      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      return { shards, passed: shards - failed, failed, shardResults };
    }),
});
