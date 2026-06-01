# @flare-dispatch/review-agent

A provider-agnostic, **Worker-side** code-review engine that calls an
OpenAI-compatible `/chat/completions` endpoint directly over
[`@effect/platform`](https://effect.website) `HttpClient`. Powers the
`pr-review` run (`runs/pr-review.ts`) — there is no `review-agent` container
CLI; every model call happens in the Worker against a configurable backend.

> **Why direct `/chat/completions`, not `@effect/ai-openai`:** that adapter's
> `OpenAiLanguageModel` only hits the OpenAI `/responses` API, but the target
> Cloudflare AI Gateway compat endpoint (`base_url = …/<gateway>/compat`) only
> supports `/chat/completions` (a `/responses` call 400s). So the engine builds
> the chat/completions request itself (see `chat.ts`).

## Engine surface

| Export | What it does |
|---|---|
| `riskTier({ diff })` | Pure heuristic → `"trivial" \| "lite" \| "full"` from diff size + sensitive paths. No model call. |
| `reviewDomain({ agent, diff, systemPrompt, tier, baseUrl, apiKey, model, backend, mode })` | One domain reviewer → `ReadonlyArray<Finding>`. `mode: "tools"` sends `tools` + `tool_choice:"required"`; `mode: "json"` parses a strict-JSON text response. Requires an `HttpClient` Layer. |
| `coordinate({ findings, previous })` / `coordinateReview(...)` | **PURE, no model call.** Merge + dedup (by `path,startLine,title`) + counts-by-`level` + verdict-by-rule → `CoordinatedReview` (no `tier`). Can never fail. |
| `chatCompletion(req)` | The transport (used by `reviewDomain`): POST `${baseUrl}/chat/completions`, returns `{ content, toolCalls }`. Non-2xx / no choices → `ModelCallFailed`. |
| `stripDiffNoise(diff)` | Drops lockfile / minified / generated / vendored file sections from a unified diff. |
| `extractJsonText(text)` | Strips `<think>…</think>` blocks + code fences and isolates the outermost JSON value — the `json`-mode parsing front-end. |
| `resolveBackend(getConfig)` | Resolves the active backend profile (base url + model + api key + mode) from config. |
| `makeModelHttpLayer()` | The `HttpClient` Layer the engine needs (the run provides it; baseUrl/apiKey/model travel on each call). |

`Finding` / `ReviewOutput` are the wire contract shared with the run.

### Request shape (per `reviewDomain` model call)

Only `reviewDomain` calls the model; `coordinate` is pure and makes no request.

```
POST ${baseUrl}/chat/completions
Authorization: Bearer ${apiKey}
Content-Type: application/json

{ "model": <model>,
  "messages": [ { "role": "system", "content": <systemPrompt> },
                { "role": "user",   "content": <diff + instruction> } ],
  "max_tokens": 2048,
  // tools mode only:
  "tools": [ { "type": "function", "function": { "name": "report", "description": …, "parameters": <jsonschema> } } ],
  "tool_choice": "required" }
```

- **tools mode** reads `choices[0].message.tool_calls[0].function.arguments` (a JSON string) → `JSON.parse` + Schema-decode. Empty `tool_calls` → auto-fallback to one `json`-mode retry.
- **json mode** reads `choices[0].message.content` → strip `<think>`/fences → `JSON.parse` + Schema-decode.

### Output mode: `tools` vs `json`

Reasoning models routed through the AI Gateway (e.g. DeepSeek-R1 distills) return **no** `tool_calls` and emit `<think>…</think>` prose, so forced tool-calling fails for them. Each backend resolves a `mode`:

- **`tools`** (opencode default) — forced tool call, Schema-validated tool args. If it returns zero `tool_calls`, the engine **auto-retries once in `json` mode**.
- **`json`** (reasonix default) — no tools; the model returns a strict JSON object that the engine strips/parses/Schema-decodes. A parse/decode failure raises `StructuredOutputInvalid`.

The mode applies to **`reviewDomain` only**. Coordination is deterministic code — `coordinate` makes no model call, so it has no mode and can never raise `StructuredOutputInvalid`. (Earlier it asked the model to re-emit the full nested `ReviewOutput`; weak models couldn't conform and the tools→json fallback didn't fire on schema mismatch — hence the move to pure assembly.)

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
