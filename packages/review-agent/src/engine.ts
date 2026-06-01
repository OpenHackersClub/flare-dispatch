// @flare-dispatch/review-agent — the Worker-side review engine.
//
// Three provider-agnostic Effect functions the `pr-review` run composes:
//
//   * `riskTier`     — a PURE heuristic on diff size + touched paths. No model
//                      call (cheaper, deterministic). trivial | lite | full.
//   * `reviewDomain` — one domain reviewer (security / performance / …). Calls
//                      the `LanguageModel` and FORCES a structured tool call so
//                      findings are Schema-validated, never hand-parsed JSON
//                      (mirrors demo-agent's `pickNextAction`).
//   * `coordinate`   — dedup / filter / verdict across all domains' findings,
//                      reconciled against the previous review. One tool call.
//
// Every model call goes through the abstract `LanguageModel` Tag — the concrete
// provider Layer is supplied by the run via `makeLanguageModelLayer` (backend.ts).
// `systemPrompt` is always SUPPLIED by the caller; this module ships only a
// generic default instruction (no project-specific rubric).

import { LanguageModel, Tool, Toolkit } from "@effect/ai";
import { Effect, Schema } from "effect";
import { classifyModelError } from "./backend.js";
import { ModelCallFailed } from "./errors.js";
import {
  type CoordinatedReview,
  Finding,
  type ReviewOutput,
  type Tier,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Generic default prompts. The caller (run) SHOULD override `systemPrompt`
// from config; these are the safe, project-neutral fallbacks.

/** Generic per-domain reviewer instruction. */
export const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are a focused code reviewer.
Review the supplied unified diff and report concrete, actionable findings for
your assigned domain only. Anchor every finding to a real file path and line
range present in the diff. Prefer a small number of high-signal findings over
many low-value ones. If the diff is clean for your domain, report zero findings.
Call the \`report\` tool exactly once with your findings (an empty array is
valid). Do not respond with prose — the tool call IS your output.`;

/** Generic coordinator instruction. */
export const DEFAULT_COORDINATE_SYSTEM_PROMPT = `You are the review coordinator.
Merge the per-domain findings into ONE consolidated review: deduplicate
overlapping findings, drop noise, and decide a verdict. Bias toward approval
unless there is a genuine critical issue. When a previous review is supplied,
auto-resolve findings that appear fixed and keep surfacing the ones still open.
Call the \`verdict\` tool exactly once.`;

// ---------------------------------------------------------------------------
// `reviewDomain` — one domain reviewer, structured output via a tool call.

/** A finding as the model emits it — tool params are Schema-validated. */
const ToolFinding = Schema.Struct({
  path: Schema.String.annotations({ description: "File path the finding is in." }),
  startLine: Schema.Number.annotations({ description: "First line (1-based)." }),
  endLine: Schema.Number.annotations({ description: "Last line (1-based)." }),
  level: Schema.Literal("notice", "warning", "failure").annotations({
    description: "Severity: notice (suggestion) | warning | failure (critical).",
  }),
  title: Schema.String.annotations({ description: "Short finding title." }),
  message: Schema.String.annotations({ description: "Explanation + suggested fix." }),
});

const ReportTool = Tool.make("report", {
  description:
    "Report this domain's review findings (possibly empty). Each finding is anchored to a file + line range in the diff.",
  parameters: {
    findings: Schema.Array(ToolFinding).annotations({
      description:
        "All findings for this domain. Empty array when the diff is clean.",
    }),
  },
});

const ReportToolkit = Toolkit.make(ReportTool);

// `disableToolCallResolution: true` keeps `@effect/ai` from invoking the stub
// handler; we read `response.toolCalls` ourselves. The handler is `Effect.void`
// because there is no side effect — the tool call IS the structured output.
const ReportToolkitHandlersLayer = ReportToolkit.toLayer({
  report: () => Effect.void,
});

export type ReviewDomainInput = {
  /** The domain this reviewer owns — e.g. "security", "performance". */
  readonly agent: string;
  /** The (noise-stripped) unified diff text. */
  readonly diff: string;
  /** Caller-supplied system prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  /** The risk tier — passed to the prompt for context. */
  readonly tier: Tier;
  /** The model id (for error reporting). */
  readonly model: string;
  /** The backend name (for error reporting). */
  readonly backend: string;
};

/**
 * Run one domain reviewer. Returns its findings (Schema-validated by the tool
 * decoder). A provider that returns no tool call despite `toolChoice:
 * "required"` is surfaced as `bad-response`.
 */
export const reviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const prompt = renderDomainPrompt(input);
    const response = yield* LanguageModel.generateText({
      prompt,
      toolkit: ReportToolkit,
      toolChoice: "required",
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(ReportToolkitHandlersLayer),
      Effect.mapError(
        (e) =>
          new ModelCallFailed({
            backend: input.backend,
            model: input.model,
            reason: classifyModelError(e),
            message: e instanceof Error ? e.message : String(e),
          }),
      ),
    );

    const calls = response.toolCalls;
    if (calls.length === 0) {
      return yield* Effect.fail(
        new ModelCallFailed({
          backend: input.backend,
          model: input.model,
          reason: "bad-response",
          message:
            "model returned no tool call despite toolChoice=required; check provider tool support",
        }),
      );
    }
    const params = calls[0]!.params as { readonly findings: ReadonlyArray<Finding> };
    return params.findings;
  });

const renderDomainPrompt = (input: ReviewDomainInput): string =>
  [
    input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
    "",
    `Review domain: ${input.agent}`,
    `Risk tier: ${input.tier}`,
    "",
    "Unified diff:",
    input.diff.length === 0 ? "(empty diff)" : input.diff,
    "",
    "Call the `report` tool exactly once with your findings for this domain.",
  ].join("\n");

// ---------------------------------------------------------------------------
// `coordinate` — dedup + verdict, structured output via a tool call.

const VerdictTool = Tool.make("verdict", {
  description:
    "Emit the consolidated review: a verdict, severity counts, and the deduplicated findings.",
  parameters: {
    verdict: Schema.Literal("approve", "comment", "request-changes").annotations({
      description:
        "approve (no blocking issues) | comment (non-blocking notes) | request-changes (critical issues).",
    }),
    critical: Schema.Number.annotations({ description: "Count of failure-level findings." }),
    warnings: Schema.Number.annotations({ description: "Count of warning-level findings." }),
    suggestions: Schema.Number.annotations({ description: "Count of notice-level findings." }),
    findings: Schema.Array(ToolFinding).annotations({
      description: "The deduplicated, filtered findings.",
    }),
  },
});

const VerdictToolkit = Toolkit.make(VerdictTool);
const VerdictToolkitHandlersLayer = VerdictToolkit.toLayer({
  verdict: () => Effect.void,
});

export type CoordinateInput = {
  /** All domains' findings, concatenated. */
  readonly findings: ReadonlyArray<Finding>;
  /** The previous execution's output for this PR, when one exists. */
  readonly previous?: ReviewOutput;
  /** Caller-supplied coordinator prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  readonly model: string;
  readonly backend: string;
};

/**
 * Coordinate the per-domain findings into one verdict. Returns
 * `CoordinatedReview` (no `tier` — the run stitches that back on from its plan).
 */
export const coordinate = (
  input: CoordinateInput,
): Effect.Effect<
  CoordinatedReview,
  ModelCallFailed,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderCoordinatePrompt(input),
      toolkit: VerdictToolkit,
      toolChoice: "required",
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(VerdictToolkitHandlersLayer),
      Effect.mapError(
        (e) =>
          new ModelCallFailed({
            backend: input.backend,
            model: input.model,
            reason: classifyModelError(e),
            message: e instanceof Error ? e.message : String(e),
          }),
      ),
    );

    const calls = response.toolCalls;
    if (calls.length === 0) {
      return yield* Effect.fail(
        new ModelCallFailed({
          backend: input.backend,
          model: input.model,
          reason: "bad-response",
          message:
            "coordinator returned no tool call despite toolChoice=required",
        }),
      );
    }
    return calls[0]!.params as CoordinatedReview;
  });

const renderCoordinatePrompt = (input: CoordinateInput): string =>
  [
    input.systemPrompt ?? DEFAULT_COORDINATE_SYSTEM_PROMPT,
    "",
    "Per-domain findings (JSON):",
    JSON.stringify(input.findings, null, 2),
    "",
    "Previous review (JSON, or none):",
    input.previous === undefined
      ? "(no previous review)"
      : JSON.stringify(input.previous, null, 2),
    "",
    "Call the `verdict` tool exactly once with the consolidated review.",
  ].join("\n");

// ---------------------------------------------------------------------------
// `riskTier` — PURE heuristic. No model call.

/**
 * Path fragments that, when touched, escalate the tier. A change to CI,
 * dependency manifests, auth, or infra is never "trivial".
 */
const SENSITIVE_PATH_FRAGMENTS = [
  ".github/",
  "Dockerfile",
  "wrangler.",
  "package.json",
  "pnpm-lock",
  "/auth",
  "/security",
  "/secrets",
  "migration",
  "infra/",
] as const;

export type RiskTierInput = {
  /** The (noise-stripped) unified diff text. */
  readonly diff: string;
};

/** Thresholds for the size heuristic — changed-line counts. */
export const RISK_THRESHOLDS = { trivial: 25, lite: 200 } as const;

/**
 * Classify a diff into a risk tier from its size + touched paths. Pure +
 * deterministic — no model call, no I/O.
 *
 *   - any sensitive path touched           → full
 *   - > `lite` changed lines               → full
 *   - > `trivial` changed lines            → lite
 *   - otherwise                            → trivial
 *
 * An empty diff is `trivial`.
 */
export const riskTier = (
  input: RiskTierInput,
): Effect.Effect<Tier> =>
  Effect.sync(() => classifyRisk(input.diff));

/** The pure core of {@link riskTier} — exported for direct unit testing. */
export const classifyRisk = (diff: string): Tier => {
  const lines = diff.split("\n");

  // Changed lines: added/removed content lines, excluding the +++/--- headers.
  const changed = lines.filter(
    (l) =>
      (l.startsWith("+") || l.startsWith("-")) &&
      !l.startsWith("+++") &&
      !l.startsWith("---"),
  ).length;

  // Touched paths: the `+++ b/<path>` headers of the unified diff.
  const touchedPaths = lines
    .filter((l) => l.startsWith("+++ "))
    .map((l) => l.replace(/^\+\+\+\s+(?:b\/)?/, "").trim());

  const touchesSensitive = touchedPaths.some((p) =>
    SENSITIVE_PATH_FRAGMENTS.some((frag) => p.includes(frag)),
  );

  if (touchesSensitive) return "full";
  if (changed > RISK_THRESHOLDS.lite) return "full";
  if (changed > RISK_THRESHOLDS.trivial) return "lite";
  return "trivial";
};
