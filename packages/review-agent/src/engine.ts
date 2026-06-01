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
// --- Transport: direct /chat/completions over HttpClient --------------------
//
// Model calls go through a direct HTTP POST to `${baseUrl}/chat/completions`
// (see chat.ts) using `@effect/platform` `HttpClient` — the run provides
// `FetchHttpClient.layer`. We do NOT use `@effect/ai-openai`'s
// `OpenAiLanguageModel`, which only hits the OpenAI `/responses` API; the target
// Cloudflare AI Gateway compat endpoint only supports `/chat/completions`.
//
// --- Output modes (per backend, resolved from CONFIG_KV) --------------------
//
// "tools" mode sends `tools` + `tool_choice: "required"` and reads
// `choices[0].message.tool_calls` (arguments are a JSON string we parse +
// Schema-decode). Reasoning models (e.g. DeepSeek-R1 distills routed through the
// AI Gateway) return NO tool_calls and emit `<think>…</think>` prose in
// `message.content` instead, so for those "json" mode sends NO tools and asks
// for a strict JSON object, strips `<think>`/code fences, then `JSON.parse` +
// Schema-decodes against the same `Finding[]` / `ReviewOutput` schemas. If
// "tools" mode comes back with zero tool_calls, the engine auto-falls-back to a
// single "json" retry.
//
// `systemPrompt` is always SUPPLIED by the caller; this module ships only a
// generic default instruction (no project-specific rubric).

import { HttpClient } from "@effect/platform";
import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import { type ReviewMode } from "./backend.js";
import {
  type ChatTool,
  chatCompletion,
  type ChatToolCall,
} from "./chat.js";
import { ModelCallFailed, StructuredOutputInvalid } from "./errors.js";
import { extractJsonText } from "./json-extract.js";
import {
  CoordinatedReview,
  type CoordinatedReview as CoordinatedReviewType,
  Finding,
  type ReviewOutput,
  type Tier,
} from "./schemas.js";

/** Token budgets for the two model surfaces. */
const REVIEW_MAX_TOKENS = 2048;
const COORDINATE_MAX_TOKENS = 2048;

/** Max chars of raw model text we attach to a `StructuredOutputInvalid`. */
const EXCERPT_LEN = 400;
const excerpt = (text: string): string => text.slice(0, EXCERPT_LEN);

/** A JSON Schema (draft-07) for a tool's `function.parameters`. */
const toolParametersSchema = (schema: Schema.Schema<any, any>): unknown => {
  const js = JSONSchema.make(schema) as unknown as Record<string, unknown>;
  // Providers want a plain parameters object — drop the `$schema` meta key.
  const { $schema: _drop, ...rest } = js;
  return rest;
};

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

/**
 * Strip `<think>`/code fences from text, isolate the JSON value, `JSON.parse`,
 * then Schema-decode. Each failure stage maps to a precise
 * `StructuredOutputInvalid.reason` so the run's PR comment can name the cause.
 * Used for both json-mode `message.content` AND a tool call's `arguments`
 * string (which is already JSON, but stripping is harmless and robust).
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
            "no JSON object found in the model response (after stripping <think> + code fences)",
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
          message: "response text was not valid JSON",
        }),
    });

    return yield* Either.match(decode(parsed), {
      onLeft: (err) =>
        Effect.fail(
          new StructuredOutputInvalid({
            ...ctx,
            reason: "schema-mismatch",
            excerpt: excerpt(candidate),
            message: `JSON did not match the expected schema — ${ParseResult.TreeFormatter.formatErrorSync(err)}`,
          }),
        ),
      onRight: (a) => Effect.succeed(a),
    });
  });

/**
 * Pick the tool call to read: the one matching `name`, else the first present
 * (single-tool requests, tolerant of a provider renaming the call). Returns
 * `undefined` only when there are NO tool calls — the empty-tool_calls signal
 * that the caller turns into `bad-response` → the json auto-fallback.
 */
const firstToolCall = (
  calls: ReadonlyArray<ChatToolCall>,
  name: string,
): ChatToolCall | undefined =>
  calls.length === 0 ? undefined : (calls.find((c) => c.name === name) ?? calls[0]);

// ---------------------------------------------------------------------------
// `reviewDomain` — one domain reviewer.

/** The `report` tool's argument shape — also the json-mode response shape. */
const DomainOutput = Schema.Struct({
  findings: Schema.Array(Finding),
});
const decodeDomainJson = Schema.decodeUnknownEither(DomainOutput);

/** The `report` tool sent in the chat/completions `tools` array (tools mode). */
const ReportTool: ChatTool = {
  type: "function",
  function: {
    name: "report",
    description:
      "Report this domain's review findings (possibly empty). Each finding is anchored to a file + line range in the diff.",
    parameters: toolParametersSchema(DomainOutput),
  },
};

export type ReviewDomainInput = {
  /** The domain this reviewer owns — e.g. "security", "performance". */
  readonly agent: string;
  /** The (noise-stripped) unified diff text. */
  readonly diff: string;
  /** Caller-supplied system prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  /** The risk tier — passed to the prompt for context. */
  readonly tier: Tier;
  /** The OpenAI-compatible base URL (`…/<gateway>/compat`). */
  readonly baseUrl: string;
  /** The API key (Bearer). */
  readonly apiKey: string;
  /** The model id. */
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
 * zero tool calls (a provider that ignores `tool_choice`), the engine
 * auto-falls-back to a single "json" retry. In "json" mode it parses a strict
 * JSON object from `message.content`.
 */
export const reviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  HttpClient.HttpClient
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

/** "tools" mode — force the `report` tool call and Schema-decode its args. */
const toolsReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const result = yield* chatCompletion({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      backend: input.backend,
      systemPrompt: input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
      userMessage: renderDomainUserMessage(input, "tools"),
      maxTokens: REVIEW_MAX_TOKENS,
      tools: [ReportTool],
    });

    const call = firstToolCall(result.toolCalls, "report");
    if (call === undefined) {
      // Empty / non-`report` tool calls → the bad-response signal the
      // auto-fallback catches.
      return yield* Effect.fail(
        new ModelCallFailed({
          backend: input.backend,
          model: input.model,
          reason: "bad-response",
          message:
            "model returned no `report` tool call despite tool_choice=required; check provider tool support",
        }),
      );
    }

    const parsed = yield* parseStructured(call.arguments, decodeDomainJson, {
      backend: input.backend,
      model: input.model,
      surface: "review",
    });
    return parsed.findings;
  });

/** "json" mode — no tools; parse a strict JSON object from `message.content`. */
const jsonReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const result = yield* chatCompletion({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      backend: input.backend,
      systemPrompt: input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
      userMessage: renderDomainUserMessage(input, "json"),
      maxTokens: REVIEW_MAX_TOKENS,
    });

    const parsed = yield* parseStructured(result.content, decodeDomainJson, {
      backend: input.backend,
      model: input.model,
      surface: "review",
    });
    return parsed.findings;
  });

/** The user-role message for a domain reviewer (system prompt is sent separately). */
const renderDomainUserMessage = (
  input: ReviewDomainInput,
  mode: ReviewMode,
): string => {
  const base = [
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
// `coordinate` — dedup + verdict.

const decodeCoordinateJson = Schema.decodeUnknownEither(CoordinatedReview);

/** The `verdict` tool sent in the chat/completions `tools` array (tools mode). */
const VerdictTool: ChatTool = {
  type: "function",
  function: {
    name: "verdict",
    description:
      "Emit the consolidated review: a verdict, severity counts, and the deduplicated findings.",
    parameters: toolParametersSchema(CoordinatedReview),
  },
};

export type CoordinateInput = {
  /** All domains' findings, concatenated. */
  readonly findings: ReadonlyArray<Finding>;
  /** The previous execution's output for this PR, when one exists. */
  readonly previous?: ReviewOutput;
  /** Caller-supplied coordinator prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  /** The OpenAI-compatible base URL (`…/<gateway>/compat`). */
  readonly baseUrl: string;
  /** The API key (Bearer). */
  readonly apiKey: string;
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
  HttpClient.HttpClient
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
  ModelCallFailed | StructuredOutputInvalid,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const result = yield* chatCompletion({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      backend: input.backend,
      systemPrompt: input.systemPrompt ?? DEFAULT_COORDINATE_SYSTEM_PROMPT,
      userMessage: renderCoordinateUserMessage(input, "tools"),
      maxTokens: COORDINATE_MAX_TOKENS,
      tools: [VerdictTool],
    });

    const call = firstToolCall(result.toolCalls, "verdict");
    if (call === undefined) {
      return yield* Effect.fail(
        new ModelCallFailed({
          backend: input.backend,
          model: input.model,
          reason: "bad-response",
          message:
            "coordinator returned no `verdict` tool call despite tool_choice=required",
        }),
      );
    }
    return yield* parseStructured(call.arguments, decodeCoordinateJson, {
      backend: input.backend,
      model: input.model,
      surface: "coordinate",
    });
  });

/** "json" mode coordinator — parse a strict JSON object from `message.content`. */
const jsonCoordinate = (
  input: CoordinateInput,
): Effect.Effect<
  CoordinatedReviewType,
  ModelCallFailed | StructuredOutputInvalid,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const result = yield* chatCompletion({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      backend: input.backend,
      systemPrompt: input.systemPrompt ?? DEFAULT_COORDINATE_SYSTEM_PROMPT,
      userMessage: renderCoordinateUserMessage(input, "json"),
      maxTokens: COORDINATE_MAX_TOKENS,
    });

    return yield* parseStructured(result.content, decodeCoordinateJson, {
      backend: input.backend,
      model: input.model,
      surface: "coordinate",
    });
  });

/** The user-role message for the coordinator (system prompt is sent separately). */
const renderCoordinateUserMessage = (
  input: CoordinateInput,
  mode: ReviewMode,
): string => {
  const base = [
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
