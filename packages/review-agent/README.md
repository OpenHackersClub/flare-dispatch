# @flare-dispatch/review-agent

A provider-agnostic, **Worker-side** code-review engine built on
[`@effect/ai`](https://effect.website). Powers the `pr-review` run
(`runs/pr-review.ts`) — there is no `review-agent` container CLI; every model
call happens in the Worker against a configurable backend.

## Engine surface

| Export | What it does |
|---|---|
| `riskTier({ diff })` | Pure heuristic → `"trivial" \| "lite" \| "full"` from diff size + sensitive paths. No model call. |
| `reviewDomain({ agent, diff, systemPrompt, tier, model, backend, mode })` | One domain reviewer → `ReadonlyArray<Finding>`. `mode: "tools"` forces a tool call; `mode: "json"` parses a strict-JSON text response. Requires a `LanguageModel` Layer. |
| `coordinate({ findings, previous, systemPrompt, model, backend, mode })` | Dedup / filter / verdict → `CoordinatedReview` (no `tier`). Same `tools` / `json` modes. |
| `stripDiffNoise(diff)` | Drops lockfile / minified / generated / vendored file sections from a unified diff. |
| `extractJsonText(text)` | Strips `<think>…</think>` blocks + code fences and isolates the outermost JSON value — the `json`-mode parsing front-end. |
| `resolveBackend(getConfig)` | Resolves the active backend profile (base url + model + api key + mode) from config. |
| `makeLanguageModelLayer(resolved)` | Builds the provider Layer (mirrors `demo-agent`'s `makeLanguageModelLayer` — an `OpenAiClient.layerConfig` over an OpenAI-compatible endpoint). |

`Finding` / `ReviewOutput` are the wire contract shared with the run.

### Output mode: `tools` vs `json`

Reasoning models routed through the AI Gateway (e.g. DeepSeek-R1 distills) return **no** `tool_calls` and emit `<think>…</think>` prose, so forced tool-calling fails for them. Each backend resolves a `mode`:

- **`tools`** (opencode default) — forced tool call, Schema-validated tool args. If it returns zero `tool_calls`, the engine **auto-retries once in `json` mode**.
- **`json`** (reasonix default) — no tools; the model returns a strict JSON object that the engine strips/parses/Schema-decodes. A parse/decode failure raises `StructuredOutputInvalid`.

## Configurable backend — operator contract

The active backend is `config.get("pr-review.backend")` → `opencode` (default)
or `reasonix`. Each is a profile resolved from CONFIG_KV + secrets:

| Backend | CONFIG_KV keys | Secret |
|---|---|---|
| `opencode` (Anthropic/Claude-class via AI Gateway compat) | `pr-review.opencode.base_url`, `pr-review.opencode.model`, `pr-review.opencode.mode` (default `tools`) | `OPENCODE_API_KEY` (or shared `MODEL_API_KEY`) |
| `reasonix` (DeepSeek via AI Gateway compat) | `pr-review.reasonix.base_url`, `pr-review.reasonix.model`, `pr-review.reasonix.mode` (default `json`) | `REASONIX_API_KEY` |

"Secrets" are CONFIG_KV entries (the `loadSecrets` store), resolved through the
same `config.get` accessor the run holds. `pr-review.prompt` optionally
overrides the per-domain reviewer system prompt; otherwise the engine's generic
default is used (no project-specific rubric is shipped).

The provider model name passes through verbatim — swapping models is a
CONFIG_KV edit, not a code change.
