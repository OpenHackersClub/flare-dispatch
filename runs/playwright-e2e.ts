// `playwright-e2e` — sharded Playwright suite with browser pool.
//
// One container per shard via the `sharded` primitive, each invoking
// `playwright test --shard=i/N`. The suite's Playwright config dials CF Browser
// Rendering for the actual browser; `requiresBrowser: true` declares the
// binding. Per-shard HTML reports upload to R2 as 30-day artifacts.
//
// Contract per specs/02-runs.md § 3. Rides on `sharded` + `workspace({ install
// : true })` so the body is "run Playwright for this shard, upload its report."
//
// The recipe at recipes/browser-tests/playwright-e2e.run.ts re-exports this
// run for self-contained copy-paste.

import { Effect, Schema } from "effect";
import { artifact, defineRun, sandbox, step } from "@flare-dispatch/core";
import { sharded, workspace } from "@flare-dispatch/core/primitives";

const PlaywrightE2EInput = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  baseURL: Schema.String,
  shards: Schema.optional(Schema.Number),
  project: Schema.optional(Schema.String),
});

const PlaywrightE2EOutput = Schema.Struct({
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

const DEFAULT_SHARDS = 4;

export const playwrightE2E = defineRun({
  name: "playwright-e2e",
  version: "1.0.0",
  image:
    "registry.cloudflare.com/openhackersclub/flare-dispatch-playwright:latest",
  inputs: PlaywrightE2EInput,
  outputs: PlaywrightE2EOutput,
  limits: { maxDurationSec: 2400, maxConcurrency: 8, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      const shards = input.shards ?? DEFAULT_SHARDS;
      const projectArg = input.project ? ["--project", input.project] : [];

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
      return {
        shards,
        passed: shards - failed,
        failed,
        shardResults,
      };
    }),
});
