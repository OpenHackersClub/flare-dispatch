// Recipe: AI code review on every PR
//
// A FlareDispatch port of Cloudflare's multi-agent code reviewer —
// https://blog.cloudflare.com/ai-code-review/ — see ./README.md for how the
// blog's design maps onto this run.
//
// Mode: Webhook mode — fires on every pull_request push, zero GHA minutes,
//       no workflow file. Drop this file into your repo's `runs/`. An
//       Action-mode alternative (./ci.yml) dispatches the same run from a
//       GitHub Actions workflow, for repos that cannot install the App.
// DSL:  see specs/03-dsl.md (uses `config` + `io.priorExecution`); inline
//       findings are posted as check-run annotations — specs/04-gha-integration.md.

import { Effect, Schema, Match, Option } from "effect";
import { defineRun, step, sandbox, config, io } from "@flare-dispatch/core";

// Local helper — true if the PR carries the given label. The webhook
// payload's pull_request.labels is an array of { name }.
const hasLabel = (
  payload: { pull_request: { labels: ReadonlyArray<{ name: string }> } },
  name: string,
): boolean => payload.pull_request.labels.some((l) => l.name === name);

// The domain-scoped reviewers, one per concern (blog: "up to seven
// domain-specific agents"). The risk tier selects which subset actually runs
// — a trivial diff never pays for all seven.
const FULL_AGENTS = [
  "security",
  "performance",
  "code-quality",
  "documentation",
  "release-management",
  "compliance",
  "agents-md",
] as const;
const LITE_AGENTS = ["security", "code-quality", "performance", "documentation"] as const;
const TRIVIAL_AGENTS = ["code-quality"] as const;

// Each Finding maps 1:1 onto a GitHub check-run annotation — the Dispatcher
// posts these inline on the PR's Files-changed tab, anchored to the exact
// lines (see specs/04-gha-integration.md § Inline findings — annotations).
const Finding = Schema.Struct({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  level: Schema.Literal("notice", "warning", "failure"),
  title: Schema.String,
  message: Schema.String,
});

// The run's output. `findings` becomes the annotation set; the rest renders
// in the check-run summary. Persisted as execution metadata, so the next
// push's re-review can read it back via `io.priorExecution`.
const ReviewOutput = Schema.Struct({
  verdict: Schema.Literal("approve", "comment", "request-changes"),
  tier: Schema.Literal("trivial", "lite", "full"),
  critical: Schema.Number,
  warnings: Schema.Number,
  suggestions: Schema.Number,
  findings: Schema.Array(Finding),
});

export const prReview = defineRun({
  name: "pr-review",
  version: "2.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-review:latest",

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
    // Optional: Webhook mode maps it from `payload.installation.id` above;
    // Action mode (./ci.yml) omits it — the Dispatcher resolves the
    // installation from the repo→installation KV map when it opens the
    // check-run. The run body itself never reads it.
    installationId: Schema.optional(Schema.Number),
  }),

  outputs: ReviewOutput,

  // 25-min overall ceiling (blog: "overall (25 min)"); fan-out concurrency is
  // bounded by the largest tier's agent count.
  limits: { maxDurationSec: 1500, maxConcurrency: FULL_AGENTS.length },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Check out the PR head.
      const repoDir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha }),
      );

      // 2. Build the reviewable diff into DIFF — a *directory* of per-file
      //    patches (blog: `diff_directory`), with lockfiles, minified assets,
      //    and generated code stripped so agents never burn tokens on noise.
      //    Each agent later reads only the slices its domain touches.
      const DIFF = "/tmp/diff";
      yield* step("prepare-diff", () =>
        sandbox.exec({
          cwd: repoDir,
          command: [
            "review-agent", "diff",
            "--base", input.baseSha,
            "--exclude", "lockfiles,minified,generated",
            "--out", DIFF,
          ],
        }),
      );

      // 3. Risk tier from diff size + touched paths.
      const tierResult = yield* step("classify-risk", () =>
        sandbox.exec({
          cwd: repoDir,
          command: ["review-agent", "risk-tier", "--diff", DIFF],
        }),
      );

      // 4. The tier IS the plan: which agents run, and which coordinator model.
      //    A trivial diff runs one generalist on a cheap model; a full review
      //    runs all seven and coordinates on the top-tier model (blog: "risk
      //    tiers prevent expensive model calls on trivial changes"). The
      //    `orElse` arm is a deliberate fail-safe — an unrecognized tier string
      //    escalates to the most thorough review, never the cheapest.
      const plan = Match.value(tierResult.stdout.trim()).pipe(
        Match.when("trivial", () => ({
          tier: "trivial" as const, agents: TRIVIAL_AGENTS, model: "sonnet" as const,
        })),
        Match.when("lite", () => ({
          tier: "lite" as const, agents: LITE_AGENTS, model: "sonnet" as const,
        })),
        Match.when("full", () => ({
          tier: "full" as const, agents: FULL_AGENTS, model: "opus" as const,
        })),
        Match.orElse(() => ({
          tier: "full" as const, agents: FULL_AGENTS, model: "opus" as const,
        })),
      );

      // 5. Resolve the coordinator model through the control plane. `config`
      //    is KV-backed: an operator can repoint `opus` at a fallback model in
      //    seconds — no redeploy — when a provider degrades (blog: Workers+KV
      //    control plane). The plan's model is the default when no override.
      const coordinatorModel = yield* step("resolve-model", () =>
        config.get(`pr-review.model.${plan.model}`).pipe(
          Effect.map((override) => override ?? plan.model),
        ),
      );

      // 6. Load the previous execution's findings for this same PR. On a
      //    re-review (a new push) the coordinator uses them to auto-resolve
      //    fixed threads and re-surface unfixed ones (blog: "re-reviews track
      //    previous findings"). Option.none() on the first push.
      const prior = yield* step("load-prior", () =>
        io.priorExecution({
          family: `pr-review:${input.repo}:${input.pr}`,
          outputSchema: ReviewOutput,
        }),
      );

      // 7. Fan out one tightly-scoped agent per domain, in parallel — only the
      //    agents this tier calls for. The shared per-file patches under DIFF
      //    keep token use down across the concurrent reviewers; each writes
      //    findings to /tmp/findings. Code-quality gets a longer leash (blog:
      //    per-task timeouts — 5 min, 10 min for code quality).
      yield* step("review", () =>
        Effect.forEach(
          plan.agents,
          (agent) =>
            sandbox.exec({
              cwd: repoDir,
              command: [
                "review-agent", "run", agent,
                "--diff", DIFF,
                "--tier", plan.tier,
                "--out", "/tmp/findings",
              ],
              timeoutSec: agent === "code-quality" ? 600 : 300,
            }),
          { concurrency: plan.agents.length },
        ),
      );

      // 8. Seed the coordinator with the prior findings, if any. The findings
      //    set is small in practice (the blog reports ~1.2 findings per
      //    review), so passing it as a CLI arg stays well under ARG_MAX.
      yield* Option.match(prior, {
        onNone: () => Effect.void,
        onSome: (p) =>
          step("seed-prior", () =>
            sandbox.exec({
              cwd: repoDir,
              command: [
                "review-agent", "seed-previous",
                "--out", "/tmp/previous.json",
                "--json", JSON.stringify(p.output.findings),
              ],
            }),
          ),
      });

      // 9. Coordinator dedups + filters the agents' findings into one verdict
      //    on the resolved model (blog: "coordinator deduplicates and filters
      //    findings"; "bias toward approval unless critical issues found").
      const review = yield* step("coordinate", () =>
        sandbox.exec({
          cwd: repoDir,
          command: [
            "review-agent", "coordinate",
            "--in", "/tmp/findings",
            "--model", coordinatorModel,
            ...(Option.isSome(prior) ? ["--previous", "/tmp/previous.json"] : []),
            "--json",
          ],
        }),
      );

      // `coordinate --json` emits { verdict, critical, warnings, suggestions,
      // findings }. The check-run summary FlareDispatch posts IS the single
      // consolidated review; each finding additionally lands as an inline
      // check-run annotation. `tier` is stitched in from the plan in step 4.
      const coordinated = JSON.parse(review.stdout) as Omit<
        Schema.Schema.Type<typeof ReviewOutput>,
        "tier"
      >;
      return { ...coordinated, tier: plan.tier };
    }),
});
