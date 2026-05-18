// Recipe: scheduled dependency audit
//
// A Schedule-mode run that audits dependencies across *every* repo the
// FlareDispatch App is installed on, every night. A vulnerability does not
// wait for your next PR — a dependency safe at merge time is disclosed days
// later. This run re-scans on a cadence so a new CVE surfaces within a day,
// not at the next push.
//
// Shape: enumerate, then fan out — the same shape as ai-code-review's
// pr-review-sweep, but the unit of work is a *repo*, not a PR. A cron tick
// names no target, so the `enumerate` step discovers them with the `github`
// capability, then the run dispatches the shipped `security-scan` run once
// per repo.
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode.
// DSL:  `schedules` on defineRun; `github.repositories()` to enumerate the
//       installed repos (specs/03-dsl.md § github); `sharded` + step.sleepUntil
//       to stagger the fan-out under the GitHub API rate limit.

import { Effect, Schema } from "effect";
import { defineRun, step, github, io, spawnChildRun } from "@flare-dispatch/core";
import { sharded } from "@flare-dispatch/core/primitives";

// The scanners every repo is audited with. `security-scan` skips a scanner
// whose ecosystem the repo doesn't use, so this list can be broad.
const SCANNERS = ["pnpm-audit", "npm-audit", "cargo-audit", "trivy-fs"] as const;

// UTC calendar date — the cron-window dedup key.
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const Input = Schema.Struct({
  // Coarse scope from schedules[].inputs — NOT a target.
  pushedWithinDays: Schema.Number, // skip repos with no recent activity
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  reposFound: Schema.Number,
  dispatched: Schema.Number, // child security-scan executions created
});

export const scheduledDeps = defineRun({
  name: "scheduled-deps",
  version: "1.0.0",

  // Schedule mode: 04:00 UTC daily. Must also appear in wrangler.jsonc
  // `triggers.crons` (specs/05-byoc.md § Wrangler config).
  schedules: [
    {
      cron: "0 4 * * *",
      idempotencyKey: ({ firedAt }) => `scheduled-deps:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ pushedWithinDays: 90, firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  // Mostly hibernating on staggered sleeps — the ceiling covers the stagger
  // window plus enumeration headroom.
  limits: { maxDurationSec: 7200, maxConcurrency: 100 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Enumerate. A cron tick names no repo — discovery is the first
      //    step. `github.repositories` is the runtime-provided, App-token
      //    -backed read surface; archived repos and ones idle beyond the
      //    window are filtered out so the audit doesn't churn on dead code.
      const repos = yield* step("enumerate", () =>
        github.repositories({
          includeArchived: false,
          pushedWithinDays: input.pushedWithinDays,
        }),
      );

      yield* step("log-scope", () =>
        io.log("info", `dependency audit: ${repos.length} repo(s)`, {
          firedAt: input.firedAt,
        }),
      );

      // 2. Fan out the shipped `security-scan` run, one child per repo,
      //    staggered across 30 min so the enumeration's API budget and the
      //    container pool never see a burst. Each child keeps a semantic,
      //    date-windowed instanceId, so a duplicate cron delivery — or an
      //    overlapping manual scan — collapses to a no-op create.
      const STAGGER_MS = 30 * 60_000;

      const outcomes = yield* sharded({
        count: repos.length,
        concurrency: repos.length,
        body: ({ index, total }) =>
          Effect.gen(function* () {
            const repo = repos[index - 1];
            const offset = Math.floor((STAGGER_MS / Math.max(total, 1)) * (index - 1));

            yield* step.sleepUntil(
              `stagger-${repo.repo}`,
              input.firedAt + offset,
            );

            return yield* step(`scan-${repo.repo}`, () =>
              spawnChildRun({
                run: "security-scan",
                instanceId: `security-scan:${repo.repo}:${isoDate(input.firedAt)}`,
                input: {
                  repo: repo.repo,
                  // Default-branch tip — a scheduled audit tracks the branch,
                  // so git.clone resolving the ref is intended.
                  sha: repo.defaultBranch,
                  scanners: SCANNERS,
                  failOn: "high",
                },
              }),
            );
          }),
      });

      const dispatched = outcomes.filter((o) => o.created).length;
      return { reposFound: repos.length, dispatched };
    }),
});
