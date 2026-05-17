// Recipe: browser tests — the `playwright-e2e` Run
//
// The typed Run that ./ci.yml dispatches. Shards a Playwright suite with
// Playwright's native --shard flag — one container per shard, all in
// parallel — and uploads a report per shard.
//
// This is the shipped `playwright-e2e` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 3. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, artifact } from "@flaredispatch/core";

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
  image: "registry.cloudflare.com/openhackersclub/flaredispatch-playwright:latest",
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 2400, maxConcurrency: 8, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      const shards = input.shards ?? 4;
      const projectArg = input.project ? ["--project", input.project] : [];

      // One container per shard, all in parallel. The suite's Playwright
      // config points at CF Browser Rendering — `requiresBrowser` declares
      // the binding so the container can reach it.
      const shardResults = yield* step("run-shards", () =>
        Effect.forEach(
          Array.from({ length: shards }, (_, i) => i + 1),
          (index) =>
            Effect.gen(function* () {
              const container = yield* sandbox.acquire({});
              const dir = yield* sandbox.git.clone({
                repo: input.repo,
                sha: input.sha,
                container,
              });
              yield* sandbox.exec({
                cwd: dir,
                container,
                command: "pnpm install --frozen-lockfile",
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: { BASE_URL: input.baseURL },
                command: [
                  "pnpm", "exec", "playwright", "test",
                  "--shard", `${index}/${shards}`,
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
          { concurrency: shards },
        ),
      );

      const failed = shardResults.filter((r) => r.exitCode !== 0).length;
      return { shards, passed: shards - failed, failed, shardResults };
    }),
});
