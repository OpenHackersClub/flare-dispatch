// Recipe: AI code review on every PR
//
// A FlareDispatch port of Cloudflare's multi-agent code reviewer —
// https://blog.cloudflare.com/ai-code-review/ — see ./README.md for how the
// blog's design maps onto this run.
//
// Drop this file into your repo's `runs/`; it is identical to the deployed
// `runs/pr-review.ts`. The review engine (`@flare-dispatch/review-agent`) runs
// in the Worker — no `review-agent` CLI in the container image.
//
// --- v3: the review runs IN THE WORKER, not a container CLI ------------------
//
// Earlier versions shelled out to a `review-agent` CLI baked into the run's
// container image. That CLI does not exist in the deployed image (every exec
// exited 127), so reviews silently failed. v3 moves the review into the run
// body via `@flare-dispatch/review-agent`, which POSTs directly to an
// OpenAI-compatible `/chat/completions` endpoint over `@effect/platform`
// HttpClient. The ONE container image (infra/Dockerfile.sandbox: Node + git +
// curl) is used only for `git` (checkout + diff); every model call happens in
// the Worker, against a CONFIGURABLE backend resolved from CONFIG_KV + secrets.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  pr-review.backend            "opencode" | "reasonix"  (default opencode)
//   CONFIG_KV  pr-review.prompt             (optional) override the per-domain reviewer system prompt
//   CONFIG_KV  pr-review.opencode.base_url  AI Gateway OpenAI-compat endpoint
//   CONFIG_KV  pr-review.opencode.model     provider-named model id (e.g. anthropic/claude-3-5-sonnet)
//   CONFIG_KV  pr-review.opencode.mode      "tools" | "json"  (default "tools")
//   secret     OPENCODE_API_KEY             (or shared MODEL_API_KEY)
//   CONFIG_KV  pr-review.reasonix.base_url  AI Gateway OpenAI-compat endpoint
//   CONFIG_KV  pr-review.reasonix.model     provider-named model id (e.g. deepseek/deepseek-chat)
//   CONFIG_KV  pr-review.reasonix.mode      "tools" | "json"  (default "json" — DeepSeek ignores forced tool-calls)
//   secret     REASONIX_API_KEY
//
// ("secret" = a CONFIG_KV entry — the `loadSecrets` store, per wrangler.jsonc.)
// A "tools"-mode backend that returns no tool_calls auto-retries once in "json"
// mode, so a provider that silently drops tool-calling still produces a review.
//
// Mode: Webhook mode — fires on every pull_request push, zero GHA minutes.
// DSL:  see specs/03-dsl.md (uses `config` + `io.priorExecution` + `github`).

import { Effect, Schema, Match, Option } from "effect";
import {
  defineRun,
  step,
  sandbox,
  config,
  io,
  github,
  StepFailed,
  type Container,
  type WebhookPayload,
} from "@flare-dispatch/core";
import { workspace } from "@flare-dispatch/core/primitives";
import {
  coordinate as engineCoordinate,
  type Finding,
  makeModelHttpLayer,
  resolveBackend,
  reviewDomain,
  riskTier,
  ReviewOutputSchema,
  stripDiffNoise,
  type Tier,
} from "@flare-dispatch/review-agent";

// Local helper — true if the PR carries the given label.
const hasLabel = (payload: WebhookPayload, name: string): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  payload.pull_request?.labels?.some((l: { name: string }) => l.name === name) ?? false;

// The domain-scoped reviewers, one per concern (blog: "up to seven
// domain-specific agents"). The risk tier selects which subset actually runs.
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

// The run's output. `findings` becomes the check-run annotation set; the rest
// renders in the summary. Persisted as execution metadata so the next push's
// re-review can read it back via `io.priorExecution`. Imported from the engine
// package so the run's `outputs` schema and the engine's return type are one
// source of truth.
const ReviewOutput = ReviewOutputSchema;

/** Footer marker on every PR comment this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: pr-review -->";

export const prReview = defineRun({
  name: "pr-review",
  version: "3.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-review:latest",

  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `pr-review:${payload.repository.full_name}:${payload.pull_request.number}:${payload.pull_request.head.sha}`,
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
    // Webhook mode maps it from `payload.installation.id`; Action mode omits
    // it. The run threads it to `github.pullReview` to authenticate the comment.
    installationId: Schema.optional(Schema.Number),
  }),

  outputs: ReviewOutput,

  limits: { maxDurationSec: 1500, maxConcurrency: FULL_AGENTS.length },

  run: (input) =>
    Effect.gen(function* () {
      // The whole review is wrapped in an error boundary that ALWAYS posts a PR
      // comment — success or failure. `reviewBody` produces the output; the
      // catch arm posts a "could not complete" comment and re-fails (as a
      // `StepFailed`, a member of `RunError`) so the check still goes red
      // honestly. The comment post itself is best-effort — a failure to post
      // must not mask the original cause.
      return yield* reviewBody(input).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const reason = describeError(err);
            yield* postComment(
              input,
              `⚠️ **pr-review could not complete**: ${reason}\n\n${COMMENT_MARKER}`,
            ).pipe(
              Effect.catchAll((postErr) =>
                io.log(
                  "warn",
                  `pr-review: failure-comment post failed — ${describeError(postErr)}`,
                ),
              ),
            );
            return yield* Effect.fail(
              new StepFailed({ step: "pr-review", cause: reason }),
            );
          }),
        ),
      );
    }),
});

// ---------------------------------------------------------------------------
// The review proper.

const reviewBody = (input: RunInput) =>
  Effect.gen(function* () {
    // 1. Check out the PR head. `git` is in the image; no dependency install.
    const { container, dir: repoDir } = yield* step("checkout", () =>
      workspace({ repo: input.repo, sha: input.sha }),
    );

    // 2. Build the reviewable diff with plain `git` (no `review-agent` CLI).
    //    A non-zero exit FAILS the step (honest red check) — see `execOrFail`.
    //    Noise (lockfiles / minified / generated) is stripped in-Worker.
    const rawDiff = yield* step("prepare-diff", () =>
      execOrFail({
        container,
        cwd: repoDir,
        command: ["git", "diff", "--unified=3", input.baseSha, input.sha],
      }).pipe(Effect.map((r) => r.stdout)),
    );
    const diff = stripDiffNoise(rawDiff);

    // 3. Risk tier — a pure heuristic on diff size + touched paths (no model
    //    call). The tier IS the plan: which agents run + the coordinator model.
    const tier = yield* step("classify-risk", () => riskTier({ diff }));
    const plan = planForTier(tier);

    // 4. Resolve the configurable backend (base url + model + api key) from
    //    CONFIG_KV + secrets, then build the provider-agnostic LanguageModel
    //    Layer. A misconfigured backend fails here → the error boundary posts
    //    a PR comment naming the missing key.
    const resolved = yield* step("resolve-backend", () =>
      resolveBackend((key) => config.get(key)),
    );
    // The engine POSTs directly to `${baseUrl}/chat/completions`; it only needs
    // an `HttpClient` Layer (the per-backend baseUrl / apiKey / model travel on
    // each call). The run provides the platform fetch client once.
    const modelLayer = makeModelHttpLayer();

    // 5. Load the previous execution's findings for this same PR. Cross the
    //    step boundary as plain `ReviewOutput | null` (CF Workflows' result
    //    serializer rejects an Effect `Option`), then rebuild the Option.
    const priorOrNull = yield* step("load-prior", () =>
      io
        .priorExecution({
          family: `pr-review:${input.repo}:${input.pr}`,
          outputSchema: ReviewOutput,
        })
        .pipe(Effect.map(Option.getOrNull)),
    );
    const prior = Option.fromNullable(priorOrNull);

    // 6. The per-domain reviewer system prompt — operator override or the
    //    engine's generic default (never a project-specific rubric here).
    const promptOverride = yield* step("resolve-prompt", () =>
      config.get("pr-review.prompt"),
    );

    // 7. Fan out one reviewer per domain, IN-WORKER, in parallel — only the
    //    agents this tier calls for. Each calls the LanguageModel via the
    //    engine; findings are Schema-validated tool-call output.
    const fanned = yield* step("review", () =>
      Effect.forEach(
        plan.agents,
        (agent) =>
          reviewDomain({
            agent,
            diff,
            tier: plan.tier,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            model: resolved.model,
            backend: resolved.backend,
            mode: resolved.mode,
            ...(promptOverride !== undefined ? { systemPrompt: promptOverride } : {}),
          }),
        { concurrency: plan.agents.length },
      ).pipe(Effect.provide(modelLayer)),
    );
    const allFindings: ReadonlyArray<Finding> = fanned.flat();

    // 8. Coordinate — PURE deterministic assembly (merge + dedup + counts +
    //    verdict). No model call, reconciled against the prior review. `tier`
    //    is stitched in from the plan.
    const coordinated = yield* step("coordinate", () =>
      engineCoordinate({
        findings: allFindings,
        ...Option.match(prior, {
          onNone: () => ({}),
          onSome: (p) => ({ previous: p.output }),
        }),
      }),
    );
    const output = { ...coordinated, tier: plan.tier };

    // 9. Post the visible top-level PR review comment (the findings additionally
    //    land as check-run annotations via the run output). Best-effort — a
    //    comment failure must not turn a green review red.
    yield* step("post-comment", () =>
      postComment(input, renderReviewComment(output)).pipe(
        Effect.catchAll((e) =>
          io.log("warn", `pr-review: posting PR comment failed — ${describeError(e)}`),
        ),
      ),
    );

    return output;
  });

// ---------------------------------------------------------------------------
// Helpers.

type RunInput = {
  readonly repo: string;
  readonly sha: string;
  readonly baseSha: string;
  readonly pr: number;
  readonly installationId?: number;
};

type Plan = {
  readonly tier: Tier;
  readonly agents: readonly string[];
  readonly model: "sonnet" | "opus";
};

/** Map the risk tier to its agent set + coordinator-model class. */
const planForTier = (tier: Tier): Plan =>
  Match.value(tier).pipe(
    Match.when("trivial", () => ({
      tier: "trivial" as const, agents: TRIVIAL_AGENTS, model: "sonnet" as const,
    })),
    Match.when("lite", () => ({
      tier: "lite" as const, agents: LITE_AGENTS, model: "sonnet" as const,
    })),
    Match.when("full", () => ({
      tier: "full" as const, agents: FULL_AGENTS, model: "opus" as const,
    })),
    Match.exhaustive,
  );

/**
 * Run a container command and FAIL the Effect when it exits non-zero. The core
 * `sandbox.exec` deliberately surfaces a non-zero exit as a normal `ExecResult`
 * (a failing test is data, not an error) — but for `pr-review`'s git steps a
 * non-zero exit IS a real failure that must turn the check red, so we lift it
 * into the typed error channel here (rather than mutating the shared
 * `sandbox.exec`, which other runs rely on).
 */
const execOrFail = (opts: {
  container: Container;
  cwd: string;
  command: readonly string[];
  timeoutSec?: number;
}) =>
  sandbox.exec(opts).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new ExecNonZero({
              command: opts.command.join(" "),
              exitCode: result.exitCode,
              stderrTail: result.stderr.slice(-2000),
            }),
          ),
    ),
  );

/** A container command that ran to completion but exited non-zero. */
class ExecNonZero extends Schema.TaggedError<ExecNonZero>()("ExecNonZero", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderrTail: Schema.String,
}) {}

/** Post a top-level PR review comment via the `github` capability. */
const postComment = (input: RunInput, body: string) =>
  github.pullReview({
    repo: input.repo,
    pr: input.pr,
    sha: input.sha,
    body,
    ...(input.installationId !== undefined
      ? { installationId: input.installationId }
      : {}),
  });

/** Human-readable one-liner for any error the boundary catches. */
const describeError = (err: unknown): string =>
  Match.value(err as { _tag?: string }).pipe(
    Match.when(
      (e) => e._tag === "BackendUnconfigured",
      (e) =>
        `backend "${(e as { backend: string }).backend}" is misconfigured — set ${(e as { missing: string }).missing}`,
    ),
    Match.when(
      (e) => e._tag === "ModelCallFailed",
      (e) =>
        `model call failed (${(e as { reason: string }).reason}): ${(e as { message: string }).message}`,
    ),
    Match.when(
      (e) => e._tag === "StructuredOutputInvalid",
      (e) =>
        `model returned unparseable ${(e as { surface: string }).surface} output (${(e as { reason: string }).reason}); the backend may need \`mode: "json"\` or a different model`,
    ),
    Match.when(
      (e) => e._tag === "ExecNonZero",
      (e) =>
        `\`${(e as { command: string }).command}\` exited ${(e as { exitCode: number }).exitCode}`,
    ),
    Match.orElse(() =>
      err instanceof Error ? err.message : JSON.stringify(err),
    ),
  );

/** Render the consolidated review as a markdown PR comment. */
const renderReviewComment = (
  output: Schema.Schema.Type<typeof ReviewOutput>,
): string => {
  const verdictBadge = Match.value(output.verdict).pipe(
    Match.when("approve", () => "✅ Approve"),
    Match.when("comment", () => "💬 Comment"),
    Match.when("request-changes", () => "🛑 Request changes"),
    Match.exhaustive,
  );

  const header = [
    `### AI code review — ${verdictBadge}`,
    "",
    `Risk tier: \`${output.tier}\` · ${output.critical} critical · ${output.warnings} warnings · ${output.suggestions} suggestions`,
  ];

  const findingsBlock =
    output.findings.length === 0
      ? ["", "_No findings._"]
      : [
          "",
          ...output.findings.slice(0, 25).map((f) => {
            const icon = Match.value(f.level).pipe(
              Match.when("failure", () => "🛑"),
              Match.when("warning", () => "⚠️"),
              Match.when("notice", () => "💡"),
              Match.exhaustive,
            );
            const loc =
              f.startLine === f.endLine
                ? `${f.path}:${f.startLine}`
                : `${f.path}:${f.startLine}-${f.endLine}`;
            return `- ${icon} **${f.title}** — \`${loc}\`\n  ${f.message}`;
          }),
          ...(output.findings.length > 25
            ? ["", `_…and ${output.findings.length - 25} more (see check annotations)._`]
            : []),
        ];

  return [...header, ...findingsBlock, "", COMMENT_MARKER].join("\n");
};
