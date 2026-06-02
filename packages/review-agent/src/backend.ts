// @flare-dispatch/review-agent — configurable model backend.
//
// The engine is provider-agnostic by construction: every model call goes through
// the `modelGateway` capability (see engine.ts), which the runtime backs with
// the Cloudflare Workers AI binding (`env.AI`) routed through an AI Gateway. The
// binding is the auth (Workers AI is account-billed), so NO per-backend API key
// is configured — that is the whole point of routing through the binding rather
// than POSTing to the gateway's `/chat/completions` endpoint.
//
// This module only resolves the backend PROFILE — which model id + output mode —
// from operator config. The model id travels with each engine call.
//
// ---------------------------------------------------------------------------
// CONFIG CONTRACT — what an operator sets (out of band) per backend.
//
// The active backend is `config.get("pr-review.backend")` →
//   "opencode" | "reasonix"   (default "opencode").
//
// Each backend is a profile of (model id, output mode):
//
//   backend "opencode"  (a tool-calling-capable Workers AI model)
//     CONFIG_KV  pr-review.opencode.model   bare Workers AI model id
//                                            e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast
//     CONFIG_KV  pr-review.opencode.mode    "tools" | "json"  (default "tools")
//
//   backend "reasonix"  (a reasoning model that doesn't honour tool-calls)
//     CONFIG_KV  pr-review.reasonix.model   bare Workers AI model id
//                                            e.g. @cf/deepseek-ai/deepseek-r1-distill-qwen-32b
//     CONFIG_KV  pr-review.reasonix.mode    "tools" | "json"  (default "json")
//
// NOTE: model ids are bare `@cf/...` (the Workers AI binding's own naming) —
// NOT the AI-Gateway-compat `workers-ai/@cf/...` prefix the old HTTP path used.
//
// --- Output mode: "tools" vs "json" -----------------------------------------
//
// Not every model honours tool-calling. Reasoning models (e.g. DeepSeek-R1
// distills) return NO tool calls and instead emit `<think>…</think>` prose. For
// those, `mode: "json"` skips tools and asks the model for a strict JSON object
// the engine parses + Schema-decodes (stripping `<think>` blocks and code fences
// first). `mode: "tools"` (the default for opencode) sends the `report` tool; if
// it comes back with zero tool calls, the engine auto-falls-back to a single
// json-mode retry.
//
// The resolver reads config through a caller-supplied `getConfig` closure so
// this module has no DSL dependency and stays unit-testable.

import { Effect, Match } from "effect";
import { BackendUnconfigured } from "./errors.js";

/** The selectable backends. Default is the first. */
export const BACKENDS = ["opencode", "reasonix"] as const;
export type Backend = (typeof BACKENDS)[number];

export const DEFAULT_BACKEND: Backend = "opencode";

/**
 * How the engine coaxes structured output from the model:
 *   "tools" — send the `report` tool and read the tool call;
 *   "json"  — no tools; the model returns a strict JSON object the engine parses.
 */
export const REVIEW_MODES = ["tools", "json"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** The CONFIG_KV key naming the active backend. */
export const BACKEND_CONFIG_KEY = "pr-review.backend";

/** Per-backend config key names — the operator contract, in one place. */
export const BACKEND_KEYS: Readonly<
  Record<
    Backend,
    {
      readonly modelKey: string;
      /** CONFIG_KV key selecting the output mode (`tools` | `json`). */
      readonly modeKey: string;
      /** Mode used when `modeKey` is unset/unrecognized. */
      readonly defaultMode: ReviewMode;
    }
  >
> = {
  opencode: {
    modelKey: "pr-review.opencode.model",
    modeKey: "pr-review.opencode.mode",
    defaultMode: "tools",
  },
  reasonix: {
    modelKey: "pr-review.reasonix.model",
    modeKey: "pr-review.reasonix.mode",
    // DeepSeek-class reasoning models don't honour tool-calls — default them
    // to json mode (validated against the live Workers AI binding).
    defaultMode: "json",
  },
};

/** A resolved backend profile — concrete values, ready to call the engine with. */
export type ResolvedBackend = {
  readonly backend: Backend;
  readonly model: string;
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
 * model fails with `BackendUnconfigured` naming the exact missing key, so the
 * run's error boundary can tell the operator what to set. No API key is read —
 * the Workers AI binding is the auth.
 */
export const resolveBackend = <R>(
  getConfig: (key: string) => Effect.Effect<string | undefined, never, R>,
): Effect.Effect<ResolvedBackend, BackendUnconfigured, R> =>
  Effect.gen(function* () {
    const backend = parseBackend(yield* getConfig(BACKEND_CONFIG_KEY));
    const keys = BACKEND_KEYS[backend];

    const model = yield* getConfig(keys.modelKey);
    if (model === undefined || model.trim() === "") {
      return yield* Effect.fail(
        new BackendUnconfigured({ backend, missing: keys.modelKey }),
      );
    }

    const mode = parseMode(yield* getConfig(keys.modeKey), keys.defaultMode);

    return { backend, model, mode };
  });

/** Map a `Match`-classified provider error to a `ModelCallFailed.reason`. */
export const classifyModelError = (
  e: unknown,
):
  | "auth-failed"
  | "rate-limited"
  | "bad-response"
  | "timeout"
  | "unknown" => {
  const message = e instanceof Error ? e.message.toLowerCase() : String(e);
  return Match.value(message).pipe(
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
