// @flare-dispatch/review-agent — the Worker-side review engine.
//
// Three Effect functions the `pr-review` run composes:
//
//   * `riskTier`     — a PURE heuristic on diff size + touched paths. No model
//                      call (cheaper, deterministic). trivial | lite | full.
//   * `reviewDomain` — one domain reviewer (security / performance / …). Gets
//                      structured findings FROM THE MODEL — either a forced
//                      tool call ("tools" mode) or a strict-JSON text response
//                      ("json" mode, for models that don't honour tool-calls).
//                      This is the only model-calling surface.
//   * `coordinate`   — PURE deterministic assembly of the reviewers' findings:
//                      merge + dedup + counts-by-severity + verdict-by-rule. No
//                      model call (the reviewers already did the work), so it
//                      can never fail with `StructuredOutputInvalid`.
//
// --- Transport (reviewDomain only): the `modelGateway` capability ------------
//
// `reviewDomain`'s model calls go through the `modelGateway` capability
// (`@flare-dispatch/core`), which the runtime backs with the Cloudflare Workers
// AI binding (`env.AI`) routed through an AI Gateway. The binding is the auth
// (Workers AI is account-billed), so NO model API key travels with the request —
// the engine carries no base url and no secret. The engine just yields the
// `ModelGateway` Tag, the way a run yields `config` / `sandbox`, and the runtime
// provides it.
//
// --- reviewDomain output modes (per backend, resolved from CONFIG_KV) --------
//
// "tools" mode sends a `report` tool and reads the model's `toolCalls`
// (Workers AI returns each tool call's `arguments` as a parsed OBJECT, though
// the engine also tolerates the OpenAI-style JSON STRING). Reasoning models
// (e.g. DeepSeek-R1 distills) return NO tool calls and emit `<think>…</think>`
// prose in `text` instead, so for those "json" mode sends NO tools and asks for
// a strict JSON object, strips `<think>`/code fences, then `JSON.parse` +
// Schema-decodes against the same `Finding[]` schema. If "tools" mode comes back
// with zero tool calls, the engine auto-falls-back to a single "json" retry.
//
// `systemPrompt` is always SUPPLIED by the caller; this module ships only a
// generic default instruction (no project-specific rubric).

import {
  modelGateway,
  ModelGateway,
  ModelGatewayError,
  type ModelTool,
  type ModelToolCall,
} from "@flare-dispatch/core";
import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import { type ReviewMode } from "./backend.js";
import { ModelCallFailed, StructuredOutputInvalid } from "./errors.js";
import { extractJsonText } from "./json-extract.js";
import {
  type CoordinatedReview as CoordinatedReviewType,
  Finding,
  type Tier,
} from "./schemas.js";

/** Token budget for a domain review model call. */
const REVIEW_MAX_TOKENS = 2048;

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

// (Coordination is deterministic — pure code — so there is no coordinator
// prompt; see `coordinate` below.)

// ---------------------------------------------------------------------------
// Shared helpers.

type StructuredCtx = {
  readonly backend: string;
  readonly model: string;
  readonly surface: "review" | "coordinate";
};

/** Schema-decode an already-parsed value, mapping a mismatch to `StructuredOutputInvalid`. */
const decodeAgainst = <A>(
  value: unknown,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
  excerptText: string,
): Effect.Effect<A, StructuredOutputInvalid> =>
  Either.match(decode(value), {
    onLeft: (err) =>
      Effect.fail(
        new StructuredOutputInvalid({
          ...ctx,
          reason: "schema-mismatch",
          excerpt: excerpt(excerptText),
          message: `value did not match the expected schema — ${ParseResult.TreeFormatter.formatErrorSync(err)}`,
        }),
      ),
    onRight: (a) => Effect.succeed(a),
  });

/**
 * Strip `<think>`/code fences from text, isolate the JSON value, `JSON.parse`,
 * then Schema-decode. Each failure stage maps to a precise
 * `StructuredOutputInvalid.reason` so the run's PR comment can name the cause.
 * The json-mode path (the model's free `text`).
 */
const parseStructured = <A>(
  text: string,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
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

    return yield* decodeAgainst(parsed, decode, ctx, candidate);
  });

/**
 * Decode a tool call's `arguments` against the schema. Workers AI returns a
 * parsed OBJECT; OpenAI-style backends return a JSON STRING. Handle both: a
 * string is `JSON.parse`d (via the text path, which also strips any stray
 * fences); an object is decoded directly.
 */
const parseToolArguments = <A>(
  args: unknown,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
): Effect.Effect<A, StructuredOutputInvalid> =>
  typeof args === "string"
    ? parseStructured(args, decode, ctx)
    : decodeAgainst(args, decode, ctx, JSON.stringify(args ?? null));

/**
 * Pick the tool call to read: the one matching `name`, else the first present
 * (single-tool requests, tolerant of a provider renaming the call). Returns
 * `undefined` only when there are NO tool calls — the empty-tool_calls signal
 * that the caller turns into `bad-response` → the json auto-fallback.
 */
const firstToolCall = (
  calls: ReadonlyArray<ModelToolCall>,
  name: string,
): ModelToolCall | undefined =>
  calls.length === 0 ? undefined : (calls.find((c) => c.name === name) ?? calls[0]);

// ---------------------------------------------------------------------------
// `reviewDomain` — one domain reviewer.

/** The `report` tool's argument shape — also the json-mode response shape. */
const DomainOutput = Schema.Struct({
  findings: Schema.Array(Finding),
});
const decodeDomainJson = Schema.decodeUnknownEither(DomainOutput);

/** The `report` tool sent to the model in tools mode. */
const ReportTool: ModelTool = {
  name: "report",
  description:
    "Report this domain's review findings (possibly empty). Each finding is anchored to a file + line range in the diff.",
  parameters: toolParametersSchema(DomainOutput),
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
  /** The model id (a bare `@cf/...` for the Workers AI binding). */
  readonly model: string;
  /** The backend name (for error reporting). */
  readonly backend: string;
  /** Output mode — "tools" (default) sends a tool; "json" parses text. */
  readonly mode?: ReviewMode;
};

/**
 * Call the model via the `modelGateway` capability, mapping its provider-agnostic
 * `ModelGatewayError` onto the engine's `ModelCallFailed` (preserving the
 * `reason` family the run's error boundary already renders).
 */
const complete = (
  input: ReviewDomainInput,
  mode: "tools" | "json",
) =>
  modelGateway
    .complete({
      model: input.model,
      system: input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
      user: renderDomainUserMessage(input, mode),
      maxTokens: REVIEW_MAX_TOKENS,
      ...(mode === "tools" ? { tools: [ReportTool] } : {}),
    })
    .pipe(
      Effect.catchTag("ModelGatewayError", (e) =>
        Effect.fail(
          new ModelCallFailed({
            backend: input.backend,
            model: e.model,
            reason: e.reason,
            message: e.message,
          }),
        ),
      ),
    );

/**
 * Run one domain reviewer. Returns its findings, Schema-validated.
 *
 * In "tools" mode the model is asked to call the `report` tool; if it returns
 * zero tool calls (a provider that ignores tool choice), the engine
 * auto-falls-back to a single "json" retry. In "json" mode it parses a strict
 * JSON object from the model's free text.
 */
export const reviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  ModelGateway
> =>
  (input.mode ?? "tools") === "json"
    ? jsonReviewDomain(input)
    : toolsReviewDomain(input).pipe(
        // Auto-fallback: a "tools" model that returned no tool call retries once
        // in json mode (the DeepSeek-via-AI-Gateway pathology). Any other
        // `ModelCallFailed` reason (and `StructuredOutputInvalid`) propagates.
        Effect.catchTag("ModelCallFailed", (e) =>
          e.reason === "bad-response" ? jsonReviewDomain(input) : Effect.fail(e),
        ),
      );

/** "tools" mode — ask for the `report` tool call and Schema-decode its args. */
const toolsReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  ModelGateway
> =>
  Effect.gen(function* () {
    const result = yield* complete(input, "tools");

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
            "model returned no `report` tool call; check provider tool support",
        }),
      );
    }

    // Workers AI returns tool args as an OBJECT; OpenAI-style as a JSON STRING.
    // `parseToolArguments` handles both before Schema-decode.
    const parsed = yield* parseToolArguments(call.arguments, decodeDomainJson, {
      backend: input.backend,
      model: input.model,
      surface: "review",
    });
    return parsed.findings;
  });

/** "json" mode — no tools; parse a strict JSON object from the model's text. */
const jsonReviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  ModelGateway
> =>
  Effect.gen(function* () {
    const result = yield* complete(input, "json");

    const parsed = yield* parseStructured(result.text, decodeDomainJson, {
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
// `coordinate` — DETERMINISTIC assembly. No model call.
//
// The per-domain reviewers already did the hard work (each emitted a
// Schema-valid `Finding[]`). Coordination is pure bookkeeping over the current
// run's findings: dedup, count by severity, and pick a verdict by rule. Doing
// this in code (rather than
// asking a model to re-emit the whole nested `ReviewOutput` via a tool call)
// removes the only remaining `StructuredOutputInvalid` failure mode — a weak
// model could never make the verdict tool-call conform, and the tools→json
// auto-fallback didn't fire on schema-mismatch.

export type CoordinateInput = {
  /** All domains' findings for THIS run, concatenated. */
  readonly findings: ReadonlyArray<Finding>;
};

/** A finding's dedup identity — same (path, startLine, title) is the same issue. */
const findingKey = (f: Finding): string =>
  `${f.path} ${f.startLine} ${f.title}`;

/**
 * Coordinate the per-domain findings into one verdict — PURE, no model call, so
 * it can never produce `StructuredOutputInvalid`. Returns `CoordinatedReview`
 * (no `tier` — the run stitches that back on from its plan).
 *
 *   - dedup by (path, startLine, title), keeping the first occurrence;
 *   - counts straight from `level` (failure/warning/notice);
 *   - verdict by rule: any failure → request-changes; else any warning →
 *     comment; else approve (bias toward approval unless critical).
 *
 * The current run is AUTHORITATIVE — only the findings the reviewers raise on
 * this push count. Nothing is carried over from a prior run, so a finding the
 * author has fixed (no longer in the diff → not re-raised) clears on its own and
 * the verdict can return to `approve`.
 */
export const coordinate = (
  input: CoordinateInput,
): Effect.Effect<CoordinatedReviewType> =>
  Effect.sync(() => coordinateReview(input));

/** The pure core of {@link coordinate} — exported for direct unit testing. */
export const coordinateReview = (
  input: CoordinateInput,
): CoordinatedReviewType => {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of input.findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }

  const critical = findings.filter((f) => f.level === "failure").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  const suggestions = findings.filter((f) => f.level === "notice").length;

  const verdict: CoordinatedReviewType["verdict"] =
    critical > 0 ? "request-changes" : warnings > 0 ? "comment" : "approve";

  return { verdict, critical, warnings, suggestions, findings };
};

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
