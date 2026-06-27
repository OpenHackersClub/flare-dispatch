// `pr-review-trail` — the trailing-coalesce companion to `pr-review`.
//
// `pr-review` declares a FIXED-WINDOW rate cap (`cooldown: { seconds: 1800,
// scope: pr-<n>, coalesce: { run: "pr-review-trail" } }`): the first commit of a
// burst is reviewed immediately (leading edge) and later commits inside the
// 30-min window are dropped. A bare leading-edge cap would leave a PR's FINAL
// state unreviewed until someone pushes again after the window — exactly
// backwards for an active PR. This run closes that gap.
//
// The dispatcher spawns ONE instance of this run per window (keyed off the
// window's prior execution id, so every collapsed push in the same window is a
// `create({id})` no-op) when a dispatch lands inside the cooldown. The run:
//
//   1. `io.sleepDurable`s out the remaining window — a durable CF Workflows
//      `step.sleep`, so the instance HIBERNATES FOR FREE (no CPU, survives Worker
//      eviction), the same pattern admission control already uses.
//   2. re-reads the PR's CURRENT head via the `github` capability — capturing
//      every commit up to wake, not just the one that triggered it.
//   3. spawns the heavy `pr-review` for that head through `childRuns`, with the
//      run's semantic instance id so a head already reviewed is a dedup no-op.
//
// Net per window: an immediate leading review, then at most one trailing review
// of wherever the PR landed — the one-per-window ceiling holds while the latest
// state is never left unreviewed. See specs/04-gha-integration.md
// § Trailing coalesce. No model calls, no sandbox container — just sleep, one
// GitHub read, one child spawn.

import { Effect, Schema } from "effect";
import { defineRun, github, io, spawnChildRun, step } from "@flare-dispatch/core";

/** Input — the stable per-PR coordinates the dispatcher knows at `cooling`. */
const PrReviewTrailInput = Schema.Struct({
  /** "owner/name". */
  repo: Schema.String,
  /** The PR number — stable across the whole window. */
  pr: Schema.Number,
  /**
   * Seconds to sleep before the trailing review — the cooldown's `retryAfterSec`
   * at the first collapsed push, i.e. time until the window reopens.
   */
  sleepSec: Schema.Number,
  /** The run to (re)dispatch against the latest head — `"pr-review"`. */
  targetRun: Schema.String,
  /** App installation id — threaded to the spawned review for its GitHub auth. */
  installationId: Schema.optional(Schema.Number),
});

/** Output — what the trailing pass decided, for the execution log. */
const PrReviewTrailOutput = Schema.Struct({
  /** "spawned" (a trailing review was dispatched) | "skipped" (nothing to do). */
  outcome: Schema.Literal("spawned", "skipped"),
  /** The head sha the trailing review targeted, when spawned. */
  headSha: Schema.optional(Schema.String),
  /** The spawned review's execution id, when spawned. */
  reviewExecutionId: Schema.optional(Schema.String),
  /** Why it skipped — `pr-closed` | `gated` — when skipped. */
  reason: Schema.optional(Schema.String),
});

/**
 * The heavy review's semantic instance id — `pr-review:{repo_}:{sha12}`, the
 * SAME string `pr-review`'s trigger `idempotencyKey` and Action mode's
 * `semanticInstanceId` produce — so the trailing review collapses onto any other
 * review of the same head (notably the nightly Schedule-mode sweep, which spawns
 * through the same `childRuns` sanitizer). NOTE: the dispatcher's webhook/Action
 * path additionally runs `toInstanceId`, which strips the `:` that `childRuns`
 * keeps; unifying those two sanitizers (so dedup is exact across ALL surfaces,
 * not just child-spawned ones) is a tracked follow-up.
 */
const reviewInstanceId = (repo: string, sha: string): string =>
  `pr-review:${repo.replace(/\//g, "_")}:${sha.slice(0, 12)}`;

export const prReviewTrail = defineRun({
  name: "pr-review-trail",
  version: "1.0.0",

  // No `triggers`: this run is never fired by a GitHub event — only spawned by
  // the dispatcher's cooldown coalesce path. No `image`: it runs no sandbox.
  inputs: PrReviewTrailInput,
  outputs: PrReviewTrailOutput,

  // The active work is tiny; the wall-clock is dominated by the durable sleep,
  // which hibernates for free. Sized to cover the full 30-min window + headroom.
  limits: { maxDurationSec: 2400 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Hibernate out the remainder of the rate-cap window. Durable: the
      //    instance is de-scheduled and resumes after `sleepSec`, surviving
      //    eviction — NOT the in-memory `io.sleep`.
      yield* io.sleepDurable("trail-window", `${input.sleepSec} seconds`);

      // 2. Re-read the PR's CURRENT head (every commit up to now, not just the
      //    push that triggered this trail). `includeDrafts` so the gate below
      //    can see a draft and decide, rather than the PR vanishing from the list.
      const pr = yield* step("fetch-head", () =>
        Effect.gen(function* () {
          const open = yield* github.openPullRequests({
            repos: [input.repo],
            includeDrafts: true,
          });
          return open.find((p) => p.number === input.pr);
        }),
      );

      // PR closed/merged since the window opened → nothing to review.
      if (pr === undefined) {
        yield* io.log(
          "info",
          `pr-review-trail: PR #${input.pr} on ${input.repo} no longer open — skipping trailing review`,
        );
        return { outcome: "skipped" as const, reason: "pr-closed" };
      }

      // Mirror `pr-review`'s webhook gate (which does NOT run on a child spawn):
      // skip a draft unless it carries `request-ai-review`, skip `skip-ai-review`,
      // skip bot authors — so the trailing pass never reviews what the leading
      // edge would have declined.
      const gatedOut =
        (pr.draft && !pr.labels.includes("request-ai-review")) ||
        pr.labels.includes("skip-ai-review") ||
        pr.author.endsWith("[bot]");
      if (gatedOut) {
        yield* io.log(
          "info",
          `pr-review-trail: PR #${input.pr} on ${input.repo} is gated out (draft/label/bot) — skipping`,
        );
        return { outcome: "skipped" as const, reason: "gated" };
      }

      // 3. Spawn the heavy review against the latest head. Idempotent: a head
      //    already reviewed at this id is a `create({id})` no-op (`created:false`).
      const handle = yield* step("spawn-review", () =>
        spawnChildRun({
          run: input.targetRun,
          input: {
            repo: input.repo,
            sha: pr.headSha,
            baseSha: pr.baseSha,
            pr: input.pr,
            ...(input.installationId !== undefined
              ? { installationId: input.installationId }
              : {}),
          },
          instanceId: reviewInstanceId(input.repo, pr.headSha),
        }),
      );

      yield* io.log(
        "info",
        `pr-review-trail: trailing review ${handle.executionId} for ${input.repo} #${input.pr} @ ${pr.headSha.slice(0, 12)}${handle.created ? "" : " (deduped — head already reviewed)"}`,
      );

      return {
        outcome: "spawned" as const,
        headSha: pr.headSha,
        reviewExecutionId: handle.executionId,
      };
    }),
});
