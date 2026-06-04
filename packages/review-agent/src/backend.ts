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
// The contract is NAMESPACED so multiple recipes can each pin their own backend
// + prompt without colliding. The flagship `pr-review` run uses the default
// namespace `"pr-review"`; a Schedule-mode recipe (e.g. `spec-drift`,
// `ci-triage`) passes its own namespace to `resolveBackend` and reads
// `<namespace>.backend`, `<namespace>.<backend>.model|mode`, `<namespace>.prompt`.
//
// The active backend is `config.get("<namespace>.backend")` →
//   "opencode" | "reasonix" | "anthropic"   (default "opencode").
//
// Each backend is a profile of (model id, output mode), for namespace `pr-review`:
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
//   backend "anthropic" (Claude via the AI Gateway universal endpoint — BYOK)
//     CONFIG_KV  pr-review.anthropic.model  `anthropic/`-prefixed model id
//                                            e.g. anthropic/claude-sonnet-4-6
//     CONFIG_KV  pr-review.anthropic.mode   "tools" | "json"  (default "tools")
//     Requires AI_GATEWAY_ID on the deploy + an Anthropic key stored in that
//     gateway (BYOK). Still no key in config — the gateway injects it.
//
// NOTE: Workers AI model ids are bare `@cf/...` (the binding's own naming) —
// NOT the AI-Gateway-compat `workers-ai/@cf/...` prefix the old HTTP path used.
// Anthropic model ids carry the `anthropic/` prefix; the runtime routes them
// via `env.AI.gateway(id).run(...)` (see runtime-cf's model-gateway-cf.ts).
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
export const BACKENDS = ["opencode", "reasonix", "anthropic"] as const;
export type Backend = (typeof BACKENDS)[number];

export const DEFAULT_BACKEND: Backend = "opencode";

/**
 * How the engine coaxes structured output from the model:
 *   "tools" — send the `report` tool and read the tool call;
 *   "json"  — no tools; the model returns a strict JSON object the engine parses.
 */
export const REVIEW_MODES = ["tools", "json"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** The default config namespace — the flagship `pr-review` run. */
export const DEFAULT_NAMESPACE = "pr-review";

/** Per-backend key descriptor — the operator contract for one backend. */
export type BackendKeyDescriptor = {
  readonly modelKey: string;
  /** CONFIG_KV key selecting the output mode (`tools` | `json`). */
  readonly modeKey: string;
  /** Mode used when `modeKey` is unset/unrecognized. */
  readonly defaultMode: ReviewMode;
  /**
   * Max chars of (noise-stripped) diff a reviewer call may carry — aligned with
   * the backend's context window, NOT one global constant. A cap above the
   * model's context doesn't truncate visibly; it overflows invisibly (the
   * provider clips or the model goes needle-blind), which reads as "reviewed
   * everything, found nothing".
   */
  readonly defaultMaxDiffChars: number;
};

/**
 * Workers AI catalog models top out around 24k–32k context tokens. ~60 KB of
 * diff ≈ 15k tokens leaves room for the system prompt + per-mode framing +
 * the response budget.
 */
const CATALOG_MAX_DIFF_CHARS = 60_000;

/**
 * Claude's context is 200k tokens; ~240 KB ≈ 60k tokens covers all but
 * pathological PRs while bounding the per-review token spend (every domain
 * reviewer embeds the whole diff).
 */
const ANTHROPIC_MAX_DIFF_CHARS = 240_000;

/**
 * Build the per-backend config key names for a given namespace — the operator
 * contract, parameterized so each recipe owns its own keys. `namespacedKeys(ns)`
 * yields `<ns>.<backend>.model` / `<ns>.<backend>.mode`.
 */
export const namespacedKeys = (
  namespace: string,
): Readonly<Record<Backend, BackendKeyDescriptor>> => ({
  opencode: {
    modelKey: `${namespace}.opencode.model`,
    modeKey: `${namespace}.opencode.mode`,
    defaultMode: "tools",
    defaultMaxDiffChars: CATALOG_MAX_DIFF_CHARS,
  },
  reasonix: {
    modelKey: `${namespace}.reasonix.model`,
    modeKey: `${namespace}.reasonix.mode`,
    // DeepSeek-class reasoning models don't honour tool-calls — default them
    // to json mode (validated against the live Workers AI binding).
    defaultMode: "json",
    defaultMaxDiffChars: CATALOG_MAX_DIFF_CHARS,
  },
  anthropic: {
    modelKey: `${namespace}.anthropic.model`,
    modeKey: `${namespace}.anthropic.mode`,
    // Claude honours forced tool use (`tool_choice: any`) reliably; tool
    // arguments come back as a parsed object the engine already tolerates.
    defaultMode: "tools",
    defaultMaxDiffChars: ANTHROPIC_MAX_DIFF_CHARS,
  },
});

/**
 * The CONFIG_KV key builder for a namespace — `namespacedKey("spec-drift")` →
 * `(suffix) => "spec-drift.<suffix>"`. The single home for the `<ns>.<key>`
 * convention, so a run reads `key("repos")` / `key("base")` instead of
 * re-interpolating the namespace at every call site.
 */
export const namespacedKey =
  (namespace: string) =>
  (suffix: string): string =>
    `${namespace}.${suffix}`;

/** The CONFIG_KV key naming the active backend for a namespace. */
export const backendConfigKey = (namespace: string): string =>
  namespacedKey(namespace)("backend");

/** The CONFIG_KV key carrying a namespace's optional system-prompt override. */
export const promptKey = (namespace: string): string =>
  namespacedKey(namespace)("prompt");

/** The CONFIG_KV key naming the active backend (default `pr-review` namespace). */
export const BACKEND_CONFIG_KEY = backendConfigKey(DEFAULT_NAMESPACE);

/** Per-backend config key names for the default `pr-review` namespace. */
export const BACKEND_KEYS: Readonly<Record<Backend, BackendKeyDescriptor>> =
  namespacedKeys(DEFAULT_NAMESPACE);

/** A resolved backend profile — concrete values, ready to call the engine with. */
export type ResolvedBackend = {
  readonly backend: Backend;
  readonly model: string;
  /** Output mode the engine drives this backend with. */
  readonly mode: ReviewMode;
  /** Diff cap (chars) sized to this backend's context window — see `capDiff`. */
  readonly maxDiffChars: number;
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
  opts: { readonly namespace?: string } = {},
): Effect.Effect<ResolvedBackend, BackendUnconfigured, R> =>
  Effect.gen(function* () {
    const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    const backend = parseBackend(yield* getConfig(backendConfigKey(namespace)));
    const keys = namespacedKeys(namespace)[backend];

    const model = yield* getConfig(keys.modelKey);
    if (model === undefined || model.trim() === "") {
      return yield* Effect.fail(
        new BackendUnconfigured({ backend, missing: keys.modelKey }),
      );
    }

    const mode = parseMode(yield* getConfig(keys.modeKey), keys.defaultMode);

    return { backend, model, mode, maxDiffChars: keys.defaultMaxDiffChars };
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
