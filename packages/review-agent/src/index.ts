// @flare-dispatch/review-agent — public API.
//
// A provider-agnostic, Worker-side code-review engine that talks to an
// OpenAI-compatible `/chat/completions` endpoint over `@effect/platform`
// `HttpClient`. The `pr-review` run composes these into a real review:
//
//   import {
//     resolveBackend, makeModelHttpLayer,
//     riskTier, reviewDomain, coordinate,
//     stripDiffNoise, ReviewOutput, type Finding,
//   } from "@flare-dispatch/review-agent";
//
// Backend selection + the operator config contract live in `backend.ts`; the
// model-calling engine in `engine.ts`; the chat/completions transport in
// `chat.ts`; the shared wire schemas in `schemas.ts`.

export {
  type Finding,
  Finding as FindingSchema,
  type Tier,
  Tier as TierSchema,
  type Verdict,
  Verdict as VerdictSchema,
  type CoordinatedReview,
  CoordinatedReview as CoordinatedReviewSchema,
  type ReviewOutput,
  ReviewOutput as ReviewOutputSchema,
} from "./schemas.js";

export {
  ModelCallFailed,
  BackendUnconfigured,
  StructuredOutputInvalid,
  type ReviewEngineError,
} from "./errors.js";

export {
  BACKENDS,
  type Backend,
  REVIEW_MODES,
  type ReviewMode,
  DEFAULT_BACKEND,
  BACKEND_CONFIG_KEY,
  BACKEND_KEYS,
  type ResolvedBackend,
  parseBackend,
  parseMode,
  resolveBackend,
  makeModelHttpLayer,
  classifyModelError,
} from "./backend.js";

export {
  type ChatRequest,
  type ChatResult,
  type ChatTool,
  type ChatToolCall,
  buildChatBody,
  chatCompletionsUrl,
  chatCompletion,
} from "./chat.js";

export {
  extractJsonText,
  stripThinkBlocks,
  stripCodeFences,
} from "./json-extract.js";

export {
  DEFAULT_REVIEW_SYSTEM_PROMPT,
  DEFAULT_COORDINATE_SYSTEM_PROMPT,
  type ReviewDomainInput,
  reviewDomain,
  type CoordinateInput,
  coordinate,
  type RiskTierInput,
  RISK_THRESHOLDS,
  riskTier,
  classifyRisk,
} from "./engine.js";

export { stripDiffNoise } from "./diff.js";
