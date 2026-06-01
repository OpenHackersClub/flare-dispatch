// @flare-dispatch/review-agent — the Worker-side review engine.
//
// Three provider-agnostic Effect functions the `pr-review` run composes:
//
//   * `riskTier`     — a PURE heuristic on diff size + touched paths. No model
//                      call (cheaper, deterministic). trivial | lite | full.
//   * `reviewDomain` — one domain reviewer (security / performance / …). Gets
//                      structured findings from the model — either a forced
//                      tool call ("tools" mode) or a strict-JSON text response
//                      ("json" mode, for models that don't honour tool-calls).
//   * `coordinate`   — dedup / filter / verdict across all domains' findings,
//                      reconciled against the previous review.
//
// --- Output modes (per backend, resolved from CONFIG_KV) --------------------
//
// "tools" mode forces a tool call (`toolChoice: "required"`) and reads
// `response.toolCalls` — Schema-validated by the tool decoder. Reasoning models
// (e.g. DeepSeek-R1 distills routed through the AI Gateway) return NO tool_calls
// and emit `<think>…</think>` prose instead, so for those "json" mode asks the
// model for a strict JSON object, strips `<think>`/code fences, then
// `JSON.parse` + Schema-decodes against the same `Finding[]` / `ReviewOutput`
// schemas. If "tools" mode comes back with zero tool_calls, the engine
// auto-falls-back to a single "json" retry.
//
// Every model call goes through the abstract `LanguageModel` Tag — the concrete
// provider Layer is supplied by the run via `makeLanguageModelLayer` (backend.ts).
// `systemPrompt` is always SUPPLIED by the caller; this module ships only a
// generic default instruction (no project-specific rubric).

import { LanguageModel, Tool, Toolkit } from "@effect/ai";
import { Effect, Either, ParseResult, Schema } from "effect";
import { classifyModelError, type ReviewMode } from "./backend.js";
import { ModelCallFailed, StructuredOutputInvalid } from "./errors.js";
import { extractJsonText } from "./json-extract.js";
import {
  CoordinatedReview,
  type CoordinatedReview as CoordinatedReviewType,
  Finding,
  type ReviewOutput,
  type Tier,
} from "./schemas.js";

/** Max chars of raw model text we attach to a `StructuredOutputInvalid`. */
const EXCERPT_LEN = 400;
const excerpt = (text: string): string => text.slice(0, EXCERPT_LEN);

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
Emit exactly one consolidated review.`;

// ---------------------------------------------------------------------------
// Shared helpers.

/** Curried mapper: any provider error → a `ModelCallFailed` for this call. */
const toModelCallFailed =
  (ctx: { readonly backend: string; readonly model: string }) =>
  (e: unknown): ModelCallFailed =>
    new ModelCallFailed({
      backend: ctx.backend,
      model: ctx.model,
      reason: classifyModelError(e),
      message: e instanceof Error ? e.message : String(e),
    });

/**
 * Strip `<think>`/code fences from a model's text response, isolate the JSON
 * value, `JSON.parse`, then Schema-decode. Each failure stage maps to a precise
 * `StructuredOutputInvalid.reason` so the run's PR comment can name the cause.
 */
const parseStructured = <A>(
  text: string,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: {
    readonly backend: string;
    readonly model: string;
    readonly surface: "review" | "coordinate";
  },
): Effect.Effect<A, StructuredOutputInvalid> =>
  Effect.gen(function* () {
    const candidate = extractJsonText(text);
    if (candidate === undefined) {
      return yield* Effect.fail(
        new StructuredOutputInvalid({
          ...ctx,
          reason: "empty",
          excerpt: excerpt(text),
          message:
            "json mode: no JSON object found in the model response (after stripping <think> + code fences)",
        }),
      );
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(candidate) as unknown,
      catch: () =>
        new StructuredOutputInvalid({
          ...ctx,
          reason: "not-json",
          excerpt: excerpt(candidate),
          message: "json mode: response text was not valid JSON",
        }),
    });

    return yield* Either.match(decode(parsed), {
      onLeft: (err) =>
        Effect.fail(
          new StructuredOutputInvalid({
            ...ctx,
            reason: "schema-mismatch",
            excerpt: excerpt(candidate),
            message: `json mode: JSON did not match the expected schema — ${ParseResult.TreeFormatter.formatErrorSync(err)}`,
          }),
        ),
      onRight: (a) => Effect.succeed(a),
    });
  });

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

/** Schema the json-mode domain response is decoded against. */
const DomainJsonOutput = Schema.Struct({
  findings: Schema.Array(Finding),
});
const decodeDomainJson = Schema.decodeUnknownEither(DomainJsonOutput);

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
  /** Output mode — "tools" (default) forces a tool call; "json" parses text. */
  readonly mode?: ReviewMode;
};

/**
 * Run one domain reviewer. Returns its findings, Schema-validated.
 *
 * In "tools" mode the model is forced to call the `report` tool; if it returns
 * zero tool calls (a provider that ignores `toolChoice`), the engine
 * auto-falls-back to a single "json" retry. In "json" mode it parses a strict
 * JSON object from the text response.
 */
export const reviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  LanguageModel.LanguageModel
> =>
  (input.mode ?? "tools") === "json"
    ? jsonReviewDomain(input)
    : toolsReviewDomain(input).pipe(
        // Auto-fallback: a "tools" model that returned no tool call retries once
        // in json mode (the DeepSeek-via-AI-Gateway pathology).
        Effect.catchIf(
          (e): e is ModelCallFailed =>
            e._tag === "ModelCallFailed" && e.reason === "bad-response",
          () => jsonReviewDomain(input),
        ),
      );

/** "tools" mode — force the `report` tool call and read its Schema-decoded args. */
const toolsReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderDomainPrompt(input, "tools"),
      toolkit: ReportToolkit,
      toolChoice: "required",
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(ReportToolkitHandlersLayer),
      Effect.mapError(toModelCallFailed(input)),
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

/** "json" mode — no tools; parse a strict JSON object from the text response. */
const jsonReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderDomainPrompt(input, "json"),
    }).pipe(Effect.mapError(toModelCallFailed(input)));

    const parsed = yield* parseStructured(
      response.text,
      decodeDomainJson,
      { backend: input.backend, model: input.model, surface: "review" },
    );
    return parsed.findings;
  });

const renderDomainPrompt = (
  input: ReviewDomainInput,
  mode: ReviewMode,
): string => {
  const base = [
    input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
    "",
    `Review domain: ${input.agent}`,
    `Risk tier: ${input.tier}`,
    "",
    "Unified diff:",
    input.diff.length === 0 ? "(empty diff)" : input.diff,
    "",
  ];
  return mode === "json"
    ? [...base, DOMAIN_JSON_INSTRUCTION].join("\n")
    : [
        ...base,
        "Call the `report` tool exactly once with your findings for this domain.",
      ].join("\n");
};

/** Strict-JSON instruction appended in "json" mode (no tools available). */
const DOMAIN_JSON_INSTRUCTION = `Respond with ONLY a single JSON object, no prose, no markdown:
{"findings":[{"path":string,"startLine":number,"endLine":number,"level":"notice"|"warning"|"failure","title":string,"message":string}]}
Use an empty "findings" array when the diff is clean for your domain. Do not wrap the JSON in code fences. Do not include any text before or after the JSON object.`;

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

const decodeCoordinateJson = Schema.decodeUnknownEither(CoordinatedReview);

export type CoordinateInput = {
  /** All domains' findings, concatenated. */
  readonly findings: ReadonlyArray<Finding>;
  /** The previous execution's output for this PR, when one exists. */
  readonly previous?: ReviewOutput;
  /** Caller-supplied coordinator prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  readonly model: string;
  readonly backend: string;
  /** Output mode — "tools" (default) forces a tool call; "json" parses text. */
  readonly mode?: ReviewMode;
};

/**
 * Coordinate the per-domain findings into one verdict. Returns
 * `CoordinatedReview` (no `tier` — the run stitches that back on from its plan).
 * Supports the same "tools" / "json" modes (+ tools→json auto-fallback) as
 * `reviewDomain`.
 */
export const coordinate = (
  input: CoordinateInput,
): Effect.Effect<
  CoordinatedReviewType,
  ModelCallFailed | StructuredOutputInvalid,
  LanguageModel.LanguageModel
> =>
  (input.mode ?? "tools") === "json"
    ? jsonCoordinate(input)
    : toolsCoordinate(input).pipe(
        Effect.catchIf(
          (e): e is ModelCallFailed =>
            e._tag === "ModelCallFailed" && e.reason === "bad-response",
          () => jsonCoordinate(input),
        ),
      );

/** "tools" mode coordinator — force the `verdict` tool call. */
const toolsCoordinate = (
  input: CoordinateInput,
): Effect.Effect<
  CoordinatedReviewType,
  ModelCallFailed,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderCoordinatePrompt(input, "tools"),
      toolkit: VerdictToolkit,
      toolChoice: "required",
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(VerdictToolkitHandlersLayer),
      Effect.mapError(toModelCallFailed(input)),
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
    return calls[0]!.params as CoordinatedReviewType;
  });

/** "json" mode coordinator — parse a strict JSON object from the text. */
const jsonCoordinate = (
  input: CoordinateInput,
): Effect.Effect<
  CoordinatedReviewType,
  ModelCallFailed | StructuredOutputInvalid,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderCoordinatePrompt(input, "json"),
    }).pipe(Effect.mapError(toModelCallFailed(input)));

    return yield* parseStructured(response.text, decodeCoordinateJson, {
      backend: input.backend,
      model: input.model,
      surface: "coordinate",
    });
  });

const renderCoordinatePrompt = (
  input: CoordinateInput,
  mode: ReviewMode,
): string => {
  const base = [
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
  ];
  return mode === "json"
    ? [...base, COORDINATE_JSON_INSTRUCTION].join("\n")
    : [
        ...base,
        "Call the `verdict` tool exactly once with the consolidated review.",
      ].join("\n");
};

/** Strict-JSON instruction appended in "json" mode (no tools available). */
const COORDINATE_JSON_INSTRUCTION = `Respond with ONLY a single JSON object, no prose, no markdown:
{"verdict":"approve"|"comment"|"request-changes","critical":number,"warnings":number,"suggestions":number,"findings":[{"path":string,"startLine":number,"endLine":number,"level":"notice"|"warning"|"failure","title":string,"message":string}]}
Do not wrap the JSON in code fences. Do not include any text before or after the JSON object.`;

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
