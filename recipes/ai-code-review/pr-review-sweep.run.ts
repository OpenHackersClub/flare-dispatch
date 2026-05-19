// Recipe: scheduled AI code-review sweep
//
// The Schedule-mode companion to pr-review.run.ts. Where `pr-review` fires on
// every PR push (Webhook mode), `pr-review-sweep` fires on a wall-clock
// cadence (Schedule mode): each cron tick it enumerates open PRs and fans out
// one `pr-review` execution per PR that still needs one. It contains NO
// review logic — it is pure orchestration. The review itself is the existing
// `pr-review` run, unchanged; the sweep only decides *what* to review and
// *when*.
//
// Mode: Schedule mode — a Cloudflare Cron Trigger drives the Dispatcher's
//       scheduled() handler, which instantiates this run as a durable
//       scheduling Workflow. See specs/04-gha-integration.md § Schedule mode
//       and specs/01-architecture.md § Schedule-mode dispatch.
// DSL:  `schedules` on defineRun (03-dsl § schedules); the `github` read
//       capability for enumeration (03-dsl § github); `sharded` +
//       step.sleepUntil to stagger the fan-out under the GitHub API rate
//       limit (03-dsl § Deferred scheduling).
//
// Why this is a *backstop*, not a duplicate channel: every child execution
// keeps the semantic instanceId `pr-review:{repo}:{pr}:{headSha}`, and CF
// Workflows treats a duplicate `create({ id })` as a no-op. So a PR already
// reviewed at its current head SHA by Webhook mode is silently skipped here —
// the sweep only spends tokens on PRs that changed since their last review,
// or that Webhook mode never saw (App installed after the push, a delivery
// dropped, the run added to an existing repo).

import { Effect, Schema } from "effect";
import { defineRun, step, github, io, spawnChildRun } from "@flare-dispatch/core";
import { sharded } from "@flare-dispatch/core/primitives";

// ISO calendar date (UTC) — the cron-window dedup key. One sweep per day.
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Coarse scope produced by schedules[].inputs. A cron tick names no target,
// so this is NOT a repo/PR — it is the filter the `enumerate` step applies.
const SweepInput = Schema.Struct({
  staleAfterHours: Schema.Number, // only PRs updated within this window
  includeDrafts: Schema.Boolean,
  firedAt: Schema.Number, // controller.scheduledTime, epoch ms
});

// The sweep's own output is a digest written to D1 execution metadata. The
// sweep posts no check-run of its own — it is not anchored to a commit; each
// child `pr-review` posts its own per-PR check-run (01-architecture
// § Schedule-mode dispatch).
const SweepOutput = Schema.Struct({
  prsFound: Schema.Number,
  dispatched: Schema.Number, // child pr-review executions actually created
  skipped: Schema.Number, // already reviewed at head SHA — no-op create
});

export const prReviewSweep = defineRun({
  name: "pr-review-sweep",
  version: "1.0.0",

  // Schedule mode: 03:00 UTC daily. This expression MUST also appear in
  // wrangler.jsonc `triggers.crons` — that array is what Cloudflare actually
  // subscribes to; `schedules` is how the scheduled() handler routes the
  // firing `controller.cron` back to this run (05-byoc § Wrangler config).
  schedules: [
    {
      cron: "0 3 * * *",
      // Cron-window key — collapses a duplicate cron delivery before any
      // Workflow is touched (04-gha-integration § Receiver dedup). The
      // scheduling Workflow's instanceId derives from this.
      idempotencyKey: ({ firedAt }) => `pr-review-sweep:${isoDate(firedAt)}`,
      // Receiver-side gate: skip weekends, before any compute is spent.
      gate: ({ firedAt }) => {
        const day = new Date(firedAt).getUTCDay();
        return day !== 0 && day !== 6;
      },
      inputs: ({ firedAt }) => ({
        staleAfterHours: 24,
        includeDrafts: false,
        firedAt,
      }),
    },
  ],

  inputs: SweepInput,
  outputs: SweepOutput,

  // The sweep spends almost all of its wall-clock hibernating on staggered
  // `sleepUntil` checkpoints, not consuming CPU. The ceiling covers the
  // 45-min stagger window plus enumeration headroom.
  limits: { maxDurationSec: 5400, maxConcurrency: 100 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Enumerate. A cron tick names no target — discovery is the first
      //    step. `github.openPullRequests` is the runtime-provided,
      //    App-token-backed read surface; it spans every repo the
      //    FlareDispatch App is installed on (03-dsl § github).
      const prs = yield* step("enumerate", () =>
        github.openPullRequests({
          updatedWithinHours: input.staleAfterHours,
          includeDrafts: input.includeDrafts,
        }),
      );

      yield* step("log-scope", () =>
        io.log("info", `sweep found ${prs.length} open PR(s)`, {
          firedAt: input.firedAt,
        }),
      );

      // 2. Fan out one `pr-review` per PR, staggered evenly across 45 min so
      //    the GitHub API and the model provider never see a burst. Each
      //    child is created with the SEMANTIC instanceId — so a PR already
      //    reviewed at its current head SHA (by Webhook mode, or an earlier
      //    sweep) is a no-op create that this run records as `skipped`.
      const STAGGER_MS = 45 * 60_000;

      const outcomes = yield* sharded({
        count: prs.length,
        concurrency: prs.length, // each child is just a create() + sleep
        body: ({ index, total }) =>
          Effect.gen(function* () {
            const pr = prs[index - 1];
            const offset = Math.floor((STAGGER_MS / Math.max(total, 1)) * (index - 1));

            // Durable sleep — the Workflow hibernates, consuming no CPU and
            // surviving eviction, until this child's slot in the window.
            yield* step.sleepUntil(
              `stagger-${pr.repo}-${pr.number}`,
              input.firedAt + offset,
            );

            return yield* step(`dispatch-${pr.repo}-${pr.number}`, () =>
              spawnChildRun({
                run: "pr-review",
                // Semantic id — identical to the key Webhook mode uses, so
                // the two modes dedup against each other for free.
                instanceId: `pr-review:${pr.repo}:${pr.number}:${pr.headSha}`,
                input: {
                  repo: pr.repo,
                  sha: pr.headSha,
                  baseSha: pr.baseSha,
                  pr: pr.number,
                  installationId: pr.installationId,
                },
              }),
            );
          }),
      });

      // `spawnChildRun` reports whether the create() actually started a new
      // instance (`created: true`) or collapsed onto an existing one
      // (`created: false` — already reviewed at this head SHA).
      const dispatched = outcomes.filter((o) => o.created).length;

      return {
        prsFound: prs.length,
        dispatched,
        skipped: prs.length - dispatched,
      };
    }),
});
