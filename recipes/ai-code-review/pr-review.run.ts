// Recipe: AI code review on every PR
//
// A FlareDispatch port of Cloudflare's multi-agent code reviewer —
// https://blog.cloudflare.com/ai-code-review/ — see ./README.md for how the
// blog's design maps onto this run.
//
// Mode: Webhook mode — fires on every pull_request push, zero GHA minutes,
//       no workflow file. Drop this file into your repo's `runs/`.
// DSL:  see specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox } from "@flaredispatch/core";

// The domain-scoped reviewers, one per concern (blog: "up to seven
// domain-specific agents"). Each is a tightly-scoped prompt that knows what
// to look for AND what to ignore. The container image bundles the agent CLI.
const AGENTS = [
  "security",
  "performance",
  "code-quality",
  "documentation",
  "release-management",
  "compliance",
  "agents-md",
] as const;

export const prReview = defineRun({
  name: "pr-review",
  version: "1.0.0",
  image: "registry.cloudflare.com/openhackersclub/flaredispatch-review:latest",

  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `pr-review:${payload.repository.full_name}:${payload.pull_request.number}:${payload.pull_request.head.sha}`,
      // skip drafts (unless explicitly requested), bots, and opt-outs
      gate: ({ payload }) =>
        (!payload.pull_request.draft || hasLabel(payload, "request-ai-review")) &&
        !hasLabel(payload, "skip-ai-review") &&
        !payload.pull_request.user.login.endsWith("[bot]"),
      inputs: ({ payload }) => ({
        repo: payload.repository.full_name,
        sha: payload.pull_request.head.sha,
        baseSha: payload.pull_request.base.sha,
        pr: payload.pull_request.number,
        installationId: payload.installation.id,
      }),
    },
  ],

  inputs: Schema.Struct({
    repo: Schema.String,
    sha: Schema.String,
    baseSha: Schema.String,
    pr: Schema.Number,
    installationId: Schema.Number,
  }),

  outputs: Schema.Struct({
    verdict: Schema.Literal("approve", "comment", "request-changes"),
    critical: Schema.Number,
    warnings: Schema.Number,
    suggestions: Schema.Number,
  }),

  limits: { maxDurationSec: 1200, maxConcurrency: AGENTS.length },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Check out the PR head.
      const repoDir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha }),
      );

      // 2. Build the reviewable diff — drop lockfiles, minified assets, and
      //    generated code so agents never burn tokens on noise.
      const diff = yield* step("prepare-diff", () =>
        sandbox.exec({
          cwd: repoDir,
          command: [
            "review-agent", "diff",
            "--base", input.baseSha,
            "--exclude", "lockfiles,minified,generated",
          ],
        }),
      );

      // 3. Risk tier from diff size + touched paths. A trivial diff skips the
      //    expensive agents entirely (blog: "risk tiers prevent expensive
      //    model calls on trivial changes").
      const tier = yield* step("classify-risk", () =>
        sandbox.exec({
          cwd: repoDir,
          command: ["review-agent", "risk-tier", "--diff", diff.logPath],
        }),
      );

      // 4. Fan out one tightly-scoped agent per domain, in parallel. A shared
      //    context file (written by prepare-diff) keeps token use down across
      //    the concurrent reviewers. Each agent writes findings to /tmp/findings.
      yield* step("review", () =>
        Effect.forEach(
          AGENTS,
          (agent) =>
            sandbox.exec({
              cwd: repoDir,
              command: [
                "review-agent", "run", agent,
                "--diff", diff.logPath,
                "--tier", tier.stdout.trim(),
                "--out", "/tmp/findings",
              ],
            }),
          { concurrency: AGENTS.length },
        ),
      );

      // 5. Coordinator dedups + filters the agents' findings into one verdict
      //    (blog: "coordinator model deduplicates and filters findings";
      //    "bias toward approval unless critical issues found").
      const review = yield* step("coordinate", () =>
        sandbox.exec({
          cwd: repoDir,
          command: ["review-agent", "coordinate", "--in", "/tmp/findings", "--json"],
        }),
      );

      // review.stdout is JSON: { verdict, critical, warnings, suggestions }.
      // The check-run summary FlareDispatch posts IS the single consolidated
      // review — no separate PR comment, no duplicates across pushes.
      return JSON.parse(review.stdout) as {
        verdict: "approve" | "comment" | "request-changes";
        critical: number;
        warnings: number;
        suggestions: number;
      };
    }),
});
