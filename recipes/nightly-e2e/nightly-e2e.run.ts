// Recipe: nightly end-to-end suite
//
// The simplest Schedule-mode shape. A Cloudflare Cron Trigger fires this run
// every night; it dispatches the shipped `playwright-e2e` run against each
// long-lived environment. No GitHub event, no PR, no enumeration — the
// targets are a fixed list known at deploy time, so `schedules[].inputs`
// produces the whole input directly.
//
// Contrast with recipes/ai-code-review/pr-review-sweep.run.ts, which must
// *discover* its targets (open PRs) at run time. When the target set is
// static, Schedule mode is just a `schedules` block plus a fixed input —
// there is no `enumerate` step.
//
// Mode: Schedule mode — a Cloudflare Cron Trigger drives the Dispatcher's
//       scheduled() handler. See specs/04-gha-integration.md § Schedule mode.
// DSL:  `schedules` on defineRun (specs/03-dsl.md § schedules); `spawnChildRun`
//       to dispatch the shipped playwright-e2e run; `sharded` to fan out.

import { Effect, Schema } from "effect";
import { defineRun, step, io, spawnChildRun } from "@flare-dispatch/core";
import { sharded } from "@flare-dispatch/core/primitives";

// The environments to exercise nightly. This list is the recipe's entire
// configuration — edit it for your deploys. `ref` is the branch whose test
// suite to run; a nightly suite tracks the branch tip, so `sandbox.git.clone`
// resolving the ref (rather than a pinned SHA) is the intended behaviour.
const ENVIRONMENTS = [
  {
    name: "staging",
    repo: "openhackersclub/flare-dispatch",
    ref: "main",
    baseURL: "https://staging.example.com",
  },
  {
    name: "canary",
    repo: "openhackersclub/flare-dispatch",
    ref: "main",
    baseURL: "https://canary.example.com",
  },
] as const;

// UTC calendar date — the cron-window dedup key.
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const Input = Schema.Struct({
  firedAt: Schema.Number, // controller.scheduledTime, epoch ms
  shardsPerEnv: Schema.Number,
});

const Output = Schema.Struct({
  environments: Schema.Number,
  dispatched: Schema.Number,
});

export const nightlyE2E = defineRun({
  name: "nightly-e2e",
  version: "1.0.0",

  // 02:00 UTC daily. This expression MUST also appear in wrangler.jsonc
  // `triggers.crons` — see specs/05-byoc.md § Wrangler config.
  schedules: [
    {
      cron: "0 2 * * *",
      // One run per calendar day; a duplicate cron delivery collapses.
      idempotencyKey: ({ firedAt }) => `nightly-e2e:${isoDate(firedAt)}`,
      // A cron tick names no target — but here the targets are static, so
      // `inputs` is the whole input. No enumeration step is needed.
      inputs: ({ firedAt }) => ({ firedAt, shardsPerEnv: 4 }),
    },
  ],

  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 3000, maxConcurrency: ENVIRONMENTS.length },

  run: (input) =>
    Effect.gen(function* () {
      yield* step("log-scope", () =>
        io.log("info", `nightly-e2e: ${ENVIRONMENTS.length} environment(s)`, {
          firedAt: input.firedAt,
        }),
      );

      // Fan out the shipped `playwright-e2e` run, one child per environment.
      // The list is static, so this is a plain count-and-index `sharded` over
      // ENVIRONMENTS — no `github` enumeration. Each child shards the suite
      // itself (`shardsPerEnv`); this run only fans out across environments.
      yield* step("dispatch", () =>
        sharded({
          count: ENVIRONMENTS.length,
          body: ({ index }) => {
            const env = ENVIRONMENTS[index - 1];
            return spawnChildRun({
              run: "playwright-e2e",
              // Semantic id — one playwright-e2e execution per env per day.
              instanceId: `playwright-e2e:${env.name}:${isoDate(input.firedAt)}`,
              input: {
                repo: env.repo,
                sha: env.ref, // branch ref — git.clone checks out the tip
                baseURL: env.baseURL,
                shards: input.shardsPerEnv,
              },
            });
          },
        }),
      );

      return {
        environments: ENVIRONMENTS.length,
        dispatched: ENVIRONMENTS.length,
      };
    }),
});
