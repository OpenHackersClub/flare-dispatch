# @flare-dispatch/review-agent

A provider-agnostic, **Worker-side** code-review engine built on
[`@effect/ai`](https://effect.website). Powers the `pr-review` run
(`runs/pr-review.ts`) — there is no `review-agent` container CLI; every model
call happens in the Worker against a configurable backend.

## Engine surface

| Export | What it does |
|---|---|
| `riskTier({ diff })` | Pure heuristic → `"trivial" \| "lite" \| "full"` from diff size + sensitive paths. No model call. |
| `reviewDomain({ agent, diff, systemPrompt, tier, model, backend })` | One domain reviewer. Forces a Schema-validated structured tool call → `ReadonlyArray<Finding>`. Requires a `LanguageModel` Layer. |
| `coordinate({ findings, previous, systemPrompt, model, backend })` | Dedup / filter / verdict → `CoordinatedReview` (no `tier`). Structured tool call. |
| `stripDiffNoise(diff)` | Drops lockfile / minified / generated / vendored file sections from a unified diff. |
| `resolveBackend(getConfig)` | Resolves the active backend profile (base url + model + api key) from config. |
| `makeLanguageModelLayer(resolved)` | Builds the provider Layer (mirrors `demo-agent`'s `makeLanguageModelLayer` — an `OpenAiClient.layerConfig` over an OpenAI-compatible endpoint). |

`Finding` / `ReviewOutput` are the wire contract shared with the run.

## Configurable backend — operator contract

The active backend is `config.get("pr-review.backend")` → `opencode` (default)
or `reasonix`. Each is a profile resolved from CONFIG_KV + secrets:

| Backend | CONFIG_KV keys | Secret |
|---|---|---|
| `opencode` (Anthropic/Claude-class via AI Gateway compat) | `pr-review.opencode.base_url`, `pr-review.opencode.model` | `OPENCODE_API_KEY` (or shared `MODEL_API_KEY`) |
| `reasonix` (DeepSeek via AI Gateway compat) | `pr-review.reasonix.base_url`, `pr-review.reasonix.model` | `REASONIX_API_KEY` |

"Secrets" are CONFIG_KV entries (the `loadSecrets` store), resolved through the
same `config.get` accessor the run holds. `pr-review.prompt` optionally
overrides the per-domain reviewer system prompt; otherwise the engine's generic
default is used (no project-specific rubric is shipped).

The provider model name passes through verbatim — swapping models is a
CONFIG_KV edit, not a code change.
