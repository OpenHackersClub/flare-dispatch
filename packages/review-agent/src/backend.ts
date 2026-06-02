// @flare-dispatch/review-agent — configurable model backend.
//
// The engine is provider-agnostic by construction: every model call is a direct
// HTTP POST to `${baseUrl}/chat/completions` (see chat.ts) over an `HttpClient`
// Layer the run provides. The concrete provider is the operator-configured
// `base_url` — in prod, Cloudflare AI Gateway's OpenAI-compatible
// `/v1/<account>/<gateway>/compat` endpoint. This module only resolves the
// backend profile (baseUrl / model / apiKey / mode) from operator config; the
// values travel with each engine call.
//
// ---------------------------------------------------------------------------
// CONFIG CONTRACT — what an operator sets (out of band) per backend.
//
// The active backend is `config.get("pr-review.backend")` →
//   "opencode" | "reasonix"   (default "opencode").
//
// Each backend is a profile of (base url, model id, api key, output mode):
//
//   backend "opencode"  (route Anthropic/Claude-class via the AI Gateway compat endpoint)
//     CONFIG_KV  pr-review.opencode.base_url   e.g. https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/compat
//     CONFIG_KV  pr-review.opencode.model      e.g. anthropic/claude-3-5-sonnet  (provider-named)
//     CONFIG_KV  pr-review.opencode.mode       "tools" | "json"  (default "tools")
//     secret     OPENCODE_API_KEY              (falls back to the shared MODEL_API_KEY)
//
//   backend "reasonix"  (route DeepSeek via the AI Gateway compat endpoint)
//     CONFIG_KV  pr-review.reasonix.base_url   e.g. https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/compat
//     CONFIG_KV  pr-review.reasonix.model      e.g. deepseek/deepseek-chat  (provider-named)
//     CONFIG_KV  pr-review.reasonix.mode       "tools" | "json"  (default "json")
//     secret     REASONIX_API_KEY
//
// --- Output mode: "tools" vs "json" -----------------------------------------
//
// Not every provider honours forced tool-calling. Reasoning models routed
// through the AI Gateway (e.g. DeepSeek-R1 distills) return NO tool_calls and
// instead emit `<think>…</think>` prose. For those, `mode: "json"` skips tools
// and asks the model for a strict JSON object the engine parses + Schema-decodes
// (stripping `<think>` blocks and code fences first). `mode: "tools"` (the
// default for opencode) keeps the forced-tool-call path; if it comes back with
// zero tool_calls, the engine auto-falls-back to a single json-mode retry.
//
// "Secrets" in flare-dispatch are CONFIG_KV entries (the `loadSecrets` store —
// see wrangler.jsonc CONFIG_KV note), so they are resolved through the same
// `config.get` accessor the run already holds. The resolver reads them through
// a caller-supplied `getConfig` closure so this module has no DSL dependency
// and stays unit-testable.

import { FetchHttpClient, type HttpClient } from "@effect/platform";
import { Effect, type Layer, Match } from "effect";
import { BackendUnconfigured } from "./errors.js";

/** The selectable backends. Default is the first. */
export const BACKENDS = ["opencode", "reasonix"] as const;
export type Backend = (typeof BACKENDS)[number];

export const DEFAULT_BACKEND: Backend = "opencode";

/**
 * How the engine coaxes structured output from the model:
 *   "tools" — forced tool-call (provider must honour `toolChoice: "required"`);
 *   "json"  — no tools; the model returns a strict JSON object the engine parses.
 */
export const REVIEW_MODES = ["tools", "json"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** The CONFIG_KV key naming the active backend. */
export const BACKEND_CONFIG_KEY = "pr-review.backend";

/** Per-backend config key + secret names — the operator contract, in one place. */
export const BACKEND_KEYS: Readonly<
  Record<
    Backend,
    {
      readonly baseUrlKey: string;
      readonly modelKey: string;
      /** CONFIG_KV key selecting the output mode (`tools` | `json`). */
      readonly modeKey: string;
      /** Mode used when `modeKey` is unset/unrecognized. */
      readonly defaultMode: ReviewMode;
      /** Preferred secret name; `OPENCODE_API_KEY` falls back to `MODEL_API_KEY`. */
      readonly apiKeyName: string;
      readonly apiKeyFallback?: string;
    }
  >
> = {
  opencode: {
    baseUrlKey: "pr-review.opencode.base_url",
    modelKey: "pr-review.opencode.model",
    modeKey: "pr-review.opencode.mode",
    defaultMode: "tools",
    apiKeyName: "OPENCODE_API_KEY",
    apiKeyFallback: "MODEL_API_KEY",
  },
  reasonix: {
    baseUrlKey: "pr-review.reasonix.base_url",
    modelKey: "pr-review.reasonix.model",
    modeKey: "pr-review.reasonix.mode",
    // DeepSeek-class reasoning models don't honour forced tool-calls — default
    // them to json mode (validated against the live AI Gateway → Workers AI).
    defaultMode: "json",
    apiKeyName: "REASONIX_API_KEY",
  },
};

/** A resolved backend profile — concrete values, ready to build a Layer from. */
export type ResolvedBackend = {
  readonly backend: Backend;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** Output mode the engine drives this backend with. */
  readonly mode: ReviewMode;
};

/** Narrow an arbitrary config string to a known `Backend`, or the default. */
export const parseBackend = (raw: string | undefined): Backend =>
  BACKENDS.includes(raw as Backend) ? (raw as Backend) : DEFAULT_BACKEND;

/** Narrow an arbitrary config string to a known `ReviewMode`, or `fallback`. */
export const parseMode = (
  raw: string | undefined,
  fallback: ReviewMode,
): ReviewMode =>
  REVIEW_MODES.includes(raw as ReviewMode) ? (raw as ReviewMode) : fallback;

/**
 * Resolve the active backend's profile from operator config. `getConfig` is the
 * `config.get`-shaped accessor — `(key) => Effect<string | undefined, never, R>`
 * — the run passes in (its `R` is the DSL's `Config` capability; this module
 * stays DSL-agnostic by leaving `R` generic and threading it through). A missing
 * base url / model / api key fails with `BackendUnconfigured` naming the exact
 * missing key, so the run's error boundary can tell the operator what to set.
 */
export const resolveBackend = <R>(
  getConfig: (key: string) => Effect.Effect<string | undefined, never, R>,
): Effect.Effect<ResolvedBackend, BackendUnconfigured, R> =>
  Effect.gen(function* () {
    const backend = parseBackend(yield* getConfig(BACKEND_CONFIG_KEY));
    const keys = BACKEND_KEYS[backend];

    const baseUrl = yield* getConfig(keys.baseUrlKey);
    if (baseUrl === undefined || baseUrl.trim() === "") {
      return yield* Effect.fail(
        new BackendUnconfigured({ backend, missing: keys.baseUrlKey }),
      );
    }

    const model = yield* getConfig(keys.modelKey);
    if (model === undefined || model.trim() === "") {
      return yield* Effect.fail(
        new BackendUnconfigured({ backend, missing: keys.modelKey }),
      );
    }

    // Primary secret, then the optional shared fallback. `.trim()` so a
    // whitespace-only secret is treated as unset (consistent with baseUrl/model)
    // rather than slipping through to fail opaquely at the provider call.
    let apiKey = yield* getConfig(keys.apiKeyName);
    if ((apiKey === undefined || apiKey.trim() === "") && keys.apiKeyFallback) {
      apiKey = yield* getConfig(keys.apiKeyFallback);
    }
    if (apiKey === undefined || apiKey.trim() === "") {
      return yield* Effect.fail(
        new BackendUnconfigured({
          backend,
          missing: keys.apiKeyFallback
            ? `${keys.apiKeyName} (or ${keys.apiKeyFallback})`
            : keys.apiKeyName,
        }),
      );
    }

    const mode = parseMode(yield* getConfig(keys.modeKey), keys.defaultMode);

    return { backend, baseUrl, model, apiKey, mode };
  });

/**
 * The `HttpClient` Layer the engine's model calls require.
 *
 * Per-backend config (baseUrl / apiKey / model) is NOT baked into the client —
 * it travels with each `reviewDomain` / `coordinate` call (the engine POSTs
 * directly to `${baseUrl}/chat/completions`, see chat.ts). So this is just the
 * platform fetch client; the run provides it once and reuses it for every call.
 *
 * (Kept as a named export so the run wires `Effect.provide(makeModelHttpLayer())`
 * — the resolved backend's fields are passed to the engine functions instead.)
 */
export const makeModelHttpLayer = (): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer;

/** Map a `Match`-classified provider error to a `ModelCallFailed.reason`. */
export const classifyModelError = (
  e: unknown,
):
  | "missing-api-key"
  | "auth-failed"
  | "rate-limited"
  | "bad-response"
  | "timeout"
  | "unknown" => {
  const message = e instanceof Error ? e.message.toLowerCase() : String(e);
  return Match.value(message).pipe(
    Match.when(
      (m) =>
        m.includes("missing-env") ||
        m.includes("missing env") ||
        m.includes("model_base_url") ||
        m.includes("model_api_key"),
      () => "missing-api-key" as const,
    ),
    Match.when(
      (m) =>
        m.includes("401") || m.includes("403") || m.includes("unauthor"),
      () => "auth-failed" as const,
    ),
    Match.when(
      (m) => m.includes("429") || m.includes("rate"),
      () => "rate-limited" as const,
    ),
    Match.when((m) => m.includes("timeout"), () => "timeout" as const),
    Match.when(
      (m) =>
        m.includes("bad") || m.includes("invalid") || m.includes("decode"),
      () => "bad-response" as const,
    ),
    Match.orElse(() => "unknown" as const),
  );
};
