// `pr-review-trail` unit tests — the trailing-coalesce run.
//
// The durable sleep is instant in the IO fake, so each test exercises the
// post-window behavior directly: fetch the PR's latest head, then spawn (or
// skip) the heavy review. `github.pullRequests` seeds `openPullRequests`;
// `handles.childRuns.spawned` records the spawn.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import type { PullRequestRef } from "@flare-dispatch/core";
import { prReviewTrail } from "./pr-review-trail";

/** A seeded open PR. Override per test. */
const pr = (over: Partial<PullRequestRef> = {}): PullRequestRef => ({
  repo: "owner/name",
  number: 42,
  headSha: "deadbeefcafe0000000000000000000000000000",
  baseSha: "0000ba5e0000000000000000000000000000beef",
  title: "Add a thing",
  draft: false,
  labels: [],
  author: "alice",
  installationId: 99,
  updatedAt: 1_700_000_000_000,
  ...over,
});

const input = {
  repo: "owner/name",
  pr: 42,
  sleepSec: 1500,
  targetRun: "pr-review",
  installationId: 99,
} as const;

describe("pr-review-trail", () => {
  it.effect("spawns a trailing review of the PR's latest head", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { pullRequests: [pr({ headSha: "feed".padEnd(40, "0") })] },
    });
    return Effect.gen(function* () {
      const out = yield* prReviewTrail.run(input);

      expect(out.outcome).toBe("spawned");
      expect(out.headSha).toBe("feed".padEnd(40, "0"));

      expect(handles.childRuns.spawned).toHaveLength(1);
      const spawn = handles.childRuns.spawned[0]!;
      expect(spawn.run).toBe("pr-review");
      const child = spawn.input as { sha: string; baseSha: string; pr: number; repo: string };
      expect(child.sha).toBe("feed".padEnd(40, "0")); // the LATEST head, re-fetched
      expect(child.baseSha).toBe(pr().baseSha);
      expect(child.pr).toBe(42);
      // Semantic id → dedups against any other review of this head.
      expect(spawn.instanceId).toContain("pr-review");
      expect(spawn.instanceId).toContain("feed00000000"); // sha12
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips when the PR is no longer open (closed/merged in-window)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { pullRequests: [] }, // PR #42 not in the open set
    });
    return Effect.gen(function* () {
      const out = yield* prReviewTrail.run(input);
      expect(out.outcome).toBe("skipped");
      expect(out.reason).toBe("pr-closed");
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a draft without `request-ai-review` (gate parity with pr-review)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { pullRequests: [pr({ draft: true, labels: [] })] },
    });
    return Effect.gen(function* () {
      const out = yield* prReviewTrail.run(input);
      expect(out.outcome).toBe("skipped");
      expect(out.reason).toBe("gated");
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reviews a draft that DOES carry `request-ai-review`", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: {
        pullRequests: [pr({ draft: true, labels: ["request-ai-review"] })],
      },
    });
    return Effect.gen(function* () {
      const out = yield* prReviewTrail.run(input);
      expect(out.outcome).toBe("spawned");
      expect(handles.childRuns.spawned).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a bot-authored PR", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { pullRequests: [pr({ author: "dependabot[bot]" })] },
    });
    return Effect.gen(function* () {
      const out = yield* prReviewTrail.run(input);
      expect(out.outcome).toBe("skipped");
      expect(out.reason).toBe("gated");
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
