// @flare-dispatch/review-agent — public API.
//
// A provider-agnostic, Worker-side code-review engine built on `@effect/ai`.
// The `pr-review` run composes these into a real review (no container CLI):
//
//   import {
//     resolveBackend, makeLanguageModelLayer,
//     riskTier, reviewDomain, coordinate,
//     stripDiffNoise, ReviewOutput, type Finding,
//   } from "@flare-dispatch/review-agent";
//
// Backend selection + the operator config contract live in `backend.ts`; the
// model-calling engine in `engine.ts`; the shared wire schemas in `schemas.ts`.

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
  makeLanguageModelLayer,
  classifyModelError,
} from "./backend.js";

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
