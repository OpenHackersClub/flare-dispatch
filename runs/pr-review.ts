// Recipe: AI code review on every PR
//
// A FlareDispatch port of Cloudflare's multi-agent code reviewer —
// https://blog.cloudflare.com/ai-code-review/ — see recipes/ai-code-review for
// how the blog's design maps onto this run.
//
// --- v3: the review runs IN THE WORKER, not a container CLI ------------------
//
// Earlier versions shelled out to a `review-agent` CLI baked into the run's
// container image. That CLI does not exist in the deployed image (every exec
// exited 127), so reviews silently failed. v3 moves the review into the run
// body via `@flare-dispatch/review-agent`, which calls a model through the
// `modelGateway` capability — backed by the Cloudflare Workers AI binding
// (`env.AI`) via an AI Gateway. The binding is the auth (Workers AI is
// account-billed), so NO model API key is configured. The ONE container image
// (infra/Dockerfile.sandbox: Node + git + curl) is used only for `git`
// (checkout + diff); every model call happens in the Worker, against a
// CONFIGURABLE backend resolved from CONFIG_KV.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  pr-review.backend         "opencode" | "reasonix" | "anthropic"  (default opencode)
//   CONFIG_KV  pr-review.prompt          (optional) override the per-domain reviewer system prompt
//   CONFIG_KV  pr-review.opencode.model  bare Workers AI model id (e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast)
//   CONFIG_KV  pr-review.opencode.mode   "tools" | "json"  (default "tools")
//   CONFIG_KV  pr-review.reasonix.model  bare Workers AI model id (e.g. @cf/deepseek-ai/deepseek-r1-distill-qwen-32b)
//   CONFIG_KV  pr-review.reasonix.mode   "tools" | "json"  (default "json" — DeepSeek ignores tool-calls)
//   CONFIG_KV  pr-review.anthropic.model `anthropic/`-prefixed model id (e.g. anthropic/claude-sonnet-4-6) — BYOK via AI Gateway
//   CONFIG_KV  pr-review.anthropic.mode  "tools" | "json"  (default "tools")
//
// No API key: the Workers AI binding is the auth. A "tools"-mode backend that
// returns no tool calls auto-retries once in "json" mode, so a model that
// silently drops tool-calling still produces a review.
//
// Mode: Webhook mode — fires on every pull_request push, zero GHA minutes.
// DSL:  see specs/03-dsl.md (uses `config` + `github`).

import { Effect, Schema, Match } from "effect";
import {
  defineRun,
  step,
  sandbox,
  config,
  io,
  github,
  type ReadFileFailed,
  StepFailed,
  type Container,
  type WebhookPayload,
} from "@flare-dispatch/core";
import { workspace } from "@flare-dispatch/core/primitives";
import {
  type BackendUnconfigured,
  capDiff,
  coordinate as engineCoordinate,
  type Finding,
  type ModelCallFailed,
  resolveBackend,
  reviewDomain,
  riskTier,
  ReviewOutputSchema,
  stripDiffNoise,
  type StructuredOutputInvalid,
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
// renders in the summary. Imported from the engine package so the run's
// `outputs` schema and the engine's return type are one source of truth. Each
// push re-reviews the full PR diff independently — the current run is
// authoritative (no carry-over from prior executions), so a fixed finding clears.
const ReviewOutput = ReviewOutputSchema;

/** Footer marker on every PR comment this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: pr-review -->";

/**
 * Where `prepare-diff` writes the unified diff inside the container. Read back
 * in full via `sandbox.readFile` — `ExecResult.stdout` inlines only a 16KB
 * tail, which silently reviewed a sliver of any sizeable PR.
 */
const DIFF_FILE = "/tmp/pr-review.diff";

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
            // Post inside a step so a CF Workflow instance retry replays from
            // the checkpoint instead of posting a duplicate failure comment.
            yield* step("post-failure-comment", () =>
              postComment(
                input,
                `⚠️ **pr-review could not complete**: ${reason}\n\n${COMMENT_MARKER}`,
              ).pipe(
                Effect.catchAll((postErr) =>
                  io.log(
                    "warn",
                    `pr-review: failure-comment post failed — ${describeError(postErr)}`,
                  ),
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
    // 1. Resolve the configurable backend (model id + output mode + diff cap)
    //    from CONFIG_KV — FIRST, before paying for a container, so a
    //    misconfigured backend fails fast → the error boundary posts a PR
    //    comment naming the missing key. No API key — the model is called
    //    through the `modelGateway` capability (Workers AI binding via an AI
    //    Gateway), which the runtime provides ambiently.
    const resolved = yield* step("resolve-backend", () =>
      resolveBackend((key) => config.get(key)),
    );

    // 2. Check out the PR head. `git` is in the image; no dependency install.
    const { container, dir: repoDir } = yield* step("checkout", () =>
      workspace({ repo: input.repo, sha: input.sha }),
    );

    // 3. Build the reviewable diff with plain `git` (no `review-agent` CLI).
    //    A non-zero exit FAILS the step (honest red check) — see `execOrFail`.
    //
    //    The diff is written to a FILE and read back with `sandbox.readFile`
    //    — NOT taken from `ExecResult.stdout`, which inlines only a bounded
    //    16KB tail (the rest streams to R2). Reading stdout silently reviewed
    //    just the last sliver of any sizeable PR: the risk tier under-counted
    //    (a huge PR classified `lite`/`trivial`), sensitive paths escaped the
    //    `full` escalation, and the reviewers "found nothing" because they
    //    never saw the change.
    //
    //    Noise-strip + backend-sized cap happen INSIDE the step so the value
    //    the Workflow checkpoints is bounded by `maxDiffChars`, never the raw
    //    multi-MB diff. One global cap sized for a frontier model would
    //    overflow a catalog model's context invisibly (the model goes
    //    needle-blind and "finds nothing") — hence the RESOLVED backend's cap.
    //
    //    THREE-dot diff (`base...head`), never two-dot: `baseSha` is the base
    //    branch TIP at event time (`pull_request.base.sha`), not the fork
    //    point. A two-dot endpoint diff on any PR behind its base reviewed
    //    `base-tip → head`, presenting everything merged to the base since
    //    the fork as DELETIONS — reviewers flagged phantom removals of files
    //    the PR never touched. Three-dot diffs from `merge-base(base, head)`,
    //    matching the PR diff GitHub itself renders.
    const diff = yield* step("prepare-diff", () =>
      execOrFail({
        container,
        cwd: repoDir,
        command: [
          "git",
          "diff",
          "--unified=3",
          `--output=${DIFF_FILE}`,
          `${input.baseSha}...${input.sha}`,
        ],
      }).pipe(
        Effect.andThen(sandbox.readFile({ container, path: DIFF_FILE })),
        Effect.map((raw) => capDiff(stripDiffNoise(raw), resolved.maxDiffChars)),
      ),
    );

    // 4. Risk tier — a pure heuristic on diff size + touched paths (no model
    //    call). The tier IS the plan: which agents run + the coordinator model.
    const tier = yield* step("classify-risk", () => riskTier({ diff }));
    const plan = planForTier(tier);

    // 5. The per-domain reviewer system prompt — operator override or the
    //    engine's generic default (never a project-specific rubric here).
    const promptOverride = yield* step("resolve-prompt", () =>
      config.get("pr-review.prompt"),
    );

    // 6. Fan out one reviewer per domain, IN-WORKER, in parallel — only the
    //    agents this tier calls for. Each calls the model via the `modelGateway`
    //    capability (provided by the runtime, like `config`/`sandbox`); findings
    //    are Schema-validated tool-call / json output.
    const fanned = yield* step("review", () =>
      Effect.forEach(
        plan.agents,
        (agent) =>
          reviewDomain({
            agent,
            diff,
            tier: plan.tier,
            model: resolved.model,
            backend: resolved.backend,
            mode: resolved.mode,
            ...(promptOverride !== undefined ? { systemPrompt: promptOverride } : {}),
          }),
        { concurrency: plan.agents.length },
      ),
    );
    const allFindings: ReadonlyArray<Finding> = fanned.flat();
    // Per-domain finding counts — rendered in the comment so an all-domains-
    // empty review is visibly "7 reviewers each reported 0", not a bare
    // "No findings" indistinguishable from the reviewers never engaging.
    const domainCounts: ReadonlyArray<DomainCount> = plan.agents.map(
      (agent, i) => ({ agent, count: fanned[i]?.length ?? 0 }),
    );

    // 7. Coordinate — PURE deterministic assembly (dedup + counts + verdict) over
    //    THIS run's findings. No model call; the current run is authoritative, so
    //    a fixed finding clears. `tier` is stitched in from the plan.
    const coordinated = yield* step("coordinate", () =>
      engineCoordinate({ findings: allFindings }),
    );
    const output = { ...coordinated, tier: plan.tier };

    // 8. Post the visible top-level PR review comment (the findings additionally
    //    land as check-run annotations via the run output). Best-effort — a
    //    comment failure must not turn a green review red.
    yield* step("post-comment", () =>
      postComment(input, renderReviewComment(input, output, domainCounts)).pipe(
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
};

/** Map the risk tier to its agent set. (The model is resolved from the backend
 *  config, not the tier — see `resolveBackend`.) */
const planForTier = (tier: Tier): Plan =>
  Match.value(tier).pipe(
    Match.when("trivial", () => ({ tier: "trivial" as const, agents: TRIVIAL_AGENTS })),
    Match.when("lite", () => ({ tier: "lite" as const, agents: LITE_AGENTS })),
    Match.when("full", () => ({ tier: "full" as const, agents: FULL_AGENTS })),
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

/** The tagged errors the review boundary knows how to describe precisely;
 *  anything else (e.g. `StepFailed`, a core capability error) falls to the
 *  `Match.orElse` arm. */
type DescribableError =
  | BackendUnconfigured
  | ModelCallFailed
  | StructuredOutputInvalid
  | ExecNonZero
  | ReadFileFailed;

/** Human-readable one-liner for any error the boundary catches. */
const describeError = (err: unknown): string =>
  Match.value(err as DescribableError).pipe(
    Match.tag(
      "BackendUnconfigured",
      (e) => `backend "${e.backend}" is misconfigured — set ${e.missing}`,
    ),
    Match.tag(
      "ModelCallFailed",
      (e) => `model call failed (${e.reason}): ${e.message}`,
    ),
    Match.tag(
      "StructuredOutputInvalid",
      (e) =>
        `model returned unparseable ${e.surface} output (${e.reason}); the backend may need \`mode: "json"\` or a different model`,
    ),
    Match.tag(
      "ExecNonZero",
      (e) => `\`${e.command}\` exited ${e.exitCode}`,
    ),
    Match.tag(
      "ReadFileFailed",
      (e) => `reading the diff file \`${e.path}\` failed: ${e.message}`,
    ),
    Match.orElse(() =>
      err instanceof Error ? err.message : JSON.stringify(err),
    ),
  );

/**
 * Neutralize model-authored text before it renders in the public PR comment.
 * The diff is attacker-controllable on a hostile PR and feeds the model, so a
 * finding's `title`/`message`/`path` could carry `@mention` pings, raw HTML, or
 * code-fence/backtick break-outs. Collapse to one line, drop angle brackets,
 * defang `@` and backticks, and bound the length. (Control flow is already safe
 * — the verdict derives only from the schema-constrained `level`.)
 */
const SANITIZE_MAX = 500;
// U+200B zero-width space — inserted after `@` it breaks GitHub's @mention
// autolink without visibly altering the text. Built from a code point so the
// source stays ASCII-only.
const ZWSP = String.fromCharCode(0x200b);
const sanitizeModelText = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/`/g, "'")
    .replace(/@(?=[\w-])/g, `@${ZWSP}`)
    .slice(0, SANITIZE_MAX);

/** One domain reviewer's engagement — how many findings it reported. */
type DomainCount = { readonly agent: string; readonly count: number };

/** How many findings render in the comment; the rest land as check annotations. */
const MAX_RENDERED_FINDINGS = 25;

/** Severity → icon + label, shared by the summary table and per-finding headings.
 *  Labels mirror the header's count names (critical / warnings / suggestions). */
const severityBadge = (level: Finding["level"]): string =>
  Match.value(level).pipe(
    Match.when("failure", () => "🛑 Critical"),
    Match.when("warning", () => "⚠️ Warning"),
    Match.when("notice", () => "💡 Suggestion"),
    Match.exhaustive,
  );

/**
 * GitHub blob URL for a finding — `https://github.com/<repo>/blob/<sha>/<path>#L<n>`.
 * `repo`/`sha` come from the trusted webhook input; `path` is model-authored, so
 * each segment is sanitized then URL-encoded (plus manual paren-encoding —
 * `encodeURIComponent` leaves `()` alone, and a bare `)` would terminate the
 * markdown link). The line fragment is dropped when the model's line numbers
 * are nonsense (≤ 0), leaving a plain file link.
 */
const findingUrl = (repo: string, sha: string, f: Finding): string => {
  const encodedPath = sanitizeModelText(f.path)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  const start = Math.floor(f.startLine);
  const end = Math.floor(f.endLine);
  const fragment = start > 0 ? (end > start ? `#L${start}-L${end}` : `#L${start}`) : "";
  return `https://github.com/${repo}/blob/${sha}/${encodedPath}${fragment}`;
};

/** `path:line` display text for a finding's location. Square brackets are
 *  stripped on top of `sanitizeModelText` — the text renders inside `[…](url)`
 *  link syntax, where a `]` would break out of the link. */
const findingLoc = (f: Finding): string => {
  const path = sanitizeModelText(f.path).replace(/[[\]]/g, "");
  return f.startLine === f.endLine
    ? `${path}:${f.startLine}`
    : `${path}:${f.startLine}-${f.endLine}`;
};

/** Sanitized text safe inside a markdown table cell — an unescaped `|` would
 *  split the row. */
const tableCell = (s: string): string => sanitizeModelText(s).replace(/\|/g, "\\|");

/** Render the consolidated review as a markdown PR comment: a summary table of
 *  every required change up front, then one heading per finding. Locations are
 *  blob links into the codebase at the reviewed SHA, not quoted paths. */
const renderReviewComment = (
  input: Pick<RunInput, "repo" | "sha">,
  output: Schema.Schema.Type<typeof ReviewOutput>,
  domainCounts: ReadonlyArray<DomainCount>,
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
    "",
    // Engagement line: every domain that ran, with its finding count — the
    // counts may exceed the deduped totals above.
    `Reviewers: ${domainCounts.map((d) => `${d.agent} ${d.count}`).join(" · ")}`,
  ];

  const rendered = output.findings.slice(0, MAX_RENDERED_FINDINGS);

  const summaryTable = [
    "",
    "| # | Severity | Change required | Location |",
    "| --- | --- | --- | --- |",
    ...rendered.map(
      (f, i) =>
        `| ${i + 1} | ${severityBadge(f.level)} | ${tableCell(f.title)} | [${tableCell(findingLoc(f))}](${findingUrl(input.repo, input.sha, f)}) |`,
    ),
  ];

  const details = rendered.flatMap((f, i) => [
    "",
    `#### ${i + 1}. ${severityBadge(f.level)} — ${sanitizeModelText(f.title)}`,
    "",
    `📍 [${findingLoc(f)}](${findingUrl(input.repo, input.sha, f)})`,
    "",
    sanitizeModelText(f.message),
  ]);

  const findingsBlock =
    output.findings.length === 0
      ? ["", "_No findings._"]
      : [
          ...summaryTable,
          ...details,
          ...(output.findings.length > MAX_RENDERED_FINDINGS
            ? [
                "",
                `_…and ${output.findings.length - MAX_RENDERED_FINDINGS} more (see check annotations)._`,
              ]
            : []),
        ];

  return [...header, ...findingsBlock, "", COMMENT_MARKER].join("\n");
};
