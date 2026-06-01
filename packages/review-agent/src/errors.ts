// @flare-dispatch/review-agent — tagged errors.
//
// One Schema.TaggedError per failure mode the engine surfaces. Callers
// (`pr-review` run) recover with `Effect.catchTag` — never `._tag` — so the
// error boundary that always posts a PR comment can render a precise reason.

import { Schema } from "effect";

/**
 * The upstream model call failed or returned an unusable response.
 * Provider-agnostic — works for any `@effect/ai` provider Layer (the
 * OpenAI-compatible AI Gateway endpoint, Workers AI, a BYOK gateway, …).
 */
export class ModelCallFailed extends Schema.TaggedError<ModelCallFailed>()(
  "ModelCallFailed",
  {
    /** The configured backend name, for the operator-facing reason string. */
    backend: Schema.String,
    /** The model id passed through to the provider. */
    model: Schema.String,
    reason: Schema.Literal(
      "missing-api-key",
      "auth-failed",
      "rate-limited",
      "bad-response",
      "timeout",
      "unknown",
    ),
    message: Schema.String,
  },
) {}

/**
 * The configured backend could not be resolved from CONFIG_KV + secrets —
 * e.g. an unknown backend name, or a required key/secret is unset.
 */
export class BackendUnconfigured extends Schema.TaggedError<BackendUnconfigured>()(
  "BackendUnconfigured",
  {
    backend: Schema.String,
    /** The missing config key or secret name, for the operator. */
    missing: Schema.String,
  },
) {}

export type ReviewEngineError = ModelCallFailed | BackendUnconfigured;
