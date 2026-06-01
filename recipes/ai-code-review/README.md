# Recipe: AI code review on every PR

A FlareDispatch port of Cloudflare's multi-agent code reviewer — [blog.cloudflare.com/ai-code-review](https://blog.cloudflare.com/ai-code-review/). The blog's system reviews merge requests with up to seven domain-specific agents, deduplicates their findings, and posts one consolidated review. This recipe implements the same shape as a FlareDispatch **run**.

## Why Webhook mode

AI review should fire on **every PR push**, on every repo, without anyone editing `.github/workflows/` and without burning GHA minutes. That is exactly [Webhook mode](../../specs/04-gha-integration.md#webhook-mode): the `FlareDispatch` GitHub App webhook fires the run directly. The recipe is therefore a single DSL file — [`pr-review.run.ts`](pr-review.run.ts) — dropped into your repo's `runs/`. No workflow file.

## How the blog's design maps onto the run

| Blog concept | In `pr-review.run.ts` |
|---|---|
| Triggered on merge-request open / update | `triggers` on `pull_request` actions `opened`, `synchronize`, `ready_for_review` |
| Noise filtering — lockfiles, minified, generated | `prepare-diff` step → plain `git diff`, then `stripDiffNoise` drops lockfile / minified / generated / vendored file sections **in the Worker** |
| Risk tiers — trivial / lite / full | `classify-risk` step → the engine's pure `riskTier` heuristic (diff size + sensitive paths); `Match` on the tier selects the agent set (1 / 4 / 7) |
| Cheaper model on trivial diffs | the tier gates how many domain reviewers fan out; the model is the operator-pinned backend (see below) |
| Workers + KV control plane — model routing without redeploy | `resolve-backend` step → `config.get("pr-review.backend")` + the backend's `base_url` / `model` keys ([03-dsl § `config`](../../specs/03-dsl.md#config)) — repoint a backend in seconds, no redeploy |
| Up to seven domain-specific agents, each tightly scoped | `FULL_AGENTS`; the tier's subset is fanned out in the `review` step (`Effect.forEach` with `concurrency`), each calling `reviewDomain` **in the Worker** |
| Shared context to cut token duplication | the single noise-stripped diff passed to every domain reviewer |
| Re-reviews track previous findings | `load-prior` step → `io.priorExecution` loads the last execution's output for this PR; `coordinate` reconciles fixed/open threads ([03-dsl § `io`](../../specs/03-dsl.md#io)) |
| Coordinator dedups + filters into one verdict | `coordinate` step → the engine's `coordinate`, a forced structured tool call (Schema-validated verdict + findings) |
| Single consolidated review | a **PR review comment** (`github.pullReview`, `event: COMMENT`) posted on every run — success AND failure — plus the check-run summary |
| Inline comments on specific lines | each `Finding` in the run output → a check-run **annotation** ([04-gha-integration § Inline findings](../../specs/04-gha-integration.md#inline-findings--annotations)) |
| Bias toward approval unless critical findings | the coordinator's generic default prompt (overridable via `pr-review.prompt`); surfaced as the `verdict` output |
| Provider-agnostic model client | `@flare-dispatch/review-agent` built on `@effect/ai` — one `LanguageModel` abstraction, the concrete provider supplied by the configured backend |

## Flow

```mermaid
flowchart LR
  PR[PR push] -->|App webhook| DSP[Dispatcher]
  DSP --> CO[checkout]
  CO --> PD[prepare-diff<br/>strip noise]
  PD --> RT[classify-risk]
  RT --> PLAN{tier?}
  PLAN -->|trivial / lite / full| FAN[review<br/>tier's agent set, parallel]
  FAN --> CRD[coordinate<br/>dedup + verdict]
  CRD --> CHK[check-run<br/>summary + inline annotations]
```

## Framework surface this recipe relies on

The run is deliberately thin — it orchestrates, it does not contain model logic. Three pieces of the framework carry the weight:

- **`config`** ([03-dsl](../../specs/03-dsl.md#config)) — a KV-backed control plane. The coordinator model is resolved at run time, so an operator can repoint it at a fallback in seconds when a provider degrades — no redeploy. This is the seam for the blog's "Workers + KV control plane."
- **`io.priorExecution`** ([03-dsl](../../specs/03-dsl.md#io)) — reads the last execution's recorded output for the same `(repo, PR)` family. That is how re-reviews stay incremental: the coordinator sees what it concluded on the previous push.
- **Check-run annotations** ([04-gha-integration](../../specs/04-gha-integration.md#inline-findings--annotations)) — the run returns a `findings` array; the Dispatcher posts each as an inline annotation on the PR's Files-changed tab. The GitHub-native equivalent of GitLab's per-line DiffNotes, with no separate review thread to manage.

## The review engine runs in the Worker

The review is performed **in the Worker run body**, not in a container CLI. The single container image (`infra/Dockerfile.sandbox`: Node + git + curl) is used only for `git` (checkout + `git diff`). Every model call goes through `@flare-dispatch/review-agent` — a provider-agnostic engine built on [`@effect/ai`](https://effect.website): `riskTier` (a pure heuristic, no model call), `reviewDomain` (one structured per-domain reviewer), and `coordinate` (dedup + verdict). Findings are Schema-validated tool-call output, never hand-parsed JSON.

> Earlier versions shelled out to a `review-agent` CLI that did **not** exist in the deployed image, so every review silently failed. Moving the engine into the Worker removes that dependency entirely.

### Configurable backend

The engine selects a model backend from config — repoint it in seconds, no redeploy:

| Key (CONFIG_KV) | Meaning |
|---|---|
| `pr-review.backend` | `opencode` (default) or `reasonix` |
| `pr-review.prompt` | *(optional)* override the generic per-domain reviewer system prompt |
| `pr-review.opencode.base_url` | AI Gateway OpenAI-compatible endpoint (`/v1/<acct>/<gw>/compat`) for the **opencode** backend (route Anthropic/Claude-class models) |
| `pr-review.opencode.model` | provider-named model id, e.g. `anthropic/claude-3-5-sonnet` |
| `pr-review.opencode.mode` | `tools` (default) or `json` — how structured output is coaxed (see below) |
| `pr-review.reasonix.base_url` | AI Gateway OpenAI-compatible endpoint for the **reasonix** backend (route DeepSeek) |
| `pr-review.reasonix.model` | provider-named model id, e.g. `deepseek/deepseek-chat` |
| `pr-review.reasonix.mode` | `tools` or `json` (**default `json`** — DeepSeek-class reasoning models ignore forced tool-calls) |

API keys are CONFIG_KV entries (the `loadSecrets` store), resolved through the same `config.get` accessor:

| Key (CONFIG_KV / secret) | Used by |
|---|---|
| `OPENCODE_API_KEY` *(or shared `MODEL_API_KEY`)* | the **opencode** backend |
| `REASONIX_API_KEY` | the **reasonix** backend |

A misconfigured backend fails fast — the run posts a PR comment naming the exact missing key.

#### Output mode: `tools` vs `json`

Not every provider honours forced tool-calling. Validated against the live AI Gateway → Workers AI: `opencode → llama-3.3-70b` returns forced tool-calls fine, but `reasonix → deepseek-r1-distill-qwen-32b` returns **no** `tool_calls` (it emits `<think>…</think>` reasoning instead).

- **`tools`** — forces a tool call (`toolChoice: "required"`) and reads the Schema-validated tool args. Best when the provider supports it.
- **`json`** — no tools; the model is asked for a strict JSON object. The engine strips `<think>…</think>` blocks and markdown code fences, isolates the JSON value, `JSON.parse`s it, and Schema-decodes against the same `Finding[]` / `ReviewOutput` schemas. A parse/decode failure surfaces a `StructuredOutputInvalid` error (the run posts a PR comment naming it).
- **Auto-fallback** — a `tools`-mode call that comes back with zero `tool_calls` retries **once** in `json` mode, so a provider that silently drops tool-calling still produces a review.

### Always a PR comment

Every run posts a top-level PR review comment (`event: COMMENT`) via the `github` capability — on success (the consolidated verdict + findings) **and** on failure (`⚠️ pr-review could not complete: <reason>`). The comment carries the `<!-- flare-dispatch: pr-review -->` footer marker.

## Scheduled sweep — [`pr-review-sweep.run.ts`](pr-review-sweep.run.ts)

`pr-review` fires on every PR push (Webhook mode). That misses three cases: a PR opened *before* the App was installed, a webhook delivery GitHub dropped, and a PR whose review you want re-run on a cadence regardless of pushes. [`pr-review-sweep.run.ts`](pr-review-sweep.run.ts) closes them — a **Schedule-mode** run ([04-gha-integration § Schedule mode](../../specs/04-gha-integration.md#schedule-mode)) that fires on a Cloudflare Cron Trigger instead of a GitHub event.

```mermaid
flowchart LR
  CRON[Cron Trigger<br/>0 3 * * *] -->|scheduled| SW[pr-review-sweep<br/>scheduling Workflow]
  SW --> ENUM[enumerate<br/>github.openPullRequests]
  ENUM --> FAN[fan out · staggered<br/>one child per PR]
  FAN --> R1[pr-review · PR #41]
  FAN --> R2[pr-review · PR #58]
  FAN --> Rn[pr-review · PR #N]
```

The sweep contains **no review logic** — it reuses the `pr-review` run above, unchanged. It only decides *what* to review and *when*:

| Concern | How the sweep handles it |
|---|---|
| A cron tick names no target | The `enumerate` step calls `github.openPullRequests` ([03-dsl § `github`](../../specs/03-dsl.md#github)) — the App-token-backed read surface — to discover every open PR across the App's installations. |
| Don't re-review unchanged PRs | Each child is created with the semantic instanceId `pr-review:{repo}:{pr}:{headSha}`. CF Workflows treats a duplicate `create({ id })` as a no-op, so a PR already reviewed at its current head SHA — by Webhook mode or an earlier sweep — is skipped for free. The sweep is a **backstop, not a duplicate channel**. |
| Don't burst the API / model provider | The fan-out is staggered with `step.sleepUntil` ([03-dsl § Deferred scheduling](../../specs/03-dsl.md#deferred-scheduling-with-stepsleepuntil)) — children are spread evenly across a 45-minute window. The scheduling Workflow hibernates between slots, consuming no CPU. |
| Skip weekends / freeze windows | The `schedules[].gate` receiver-side check skips the tick before any Workflow is created. |

The cadence (`0 3 * * *`) lives in the run's `schedules` **and** in `wrangler.jsonc` `triggers.crons` — the latter is what Cloudflare subscribes to ([05-byoc § Wrangler config](../../specs/05-byoc.md#wrangler-config)). The sweep posts no check-run of its own; each child `pr-review` posts its own per-PR check exactly as in Webhook mode.

## Install

1. Deploy FlareDispatch and install the GitHub App — [specs/05-byoc.md](../../specs/05-byoc.md).
2. Copy `pr-review.run.ts` into your repo's `runs/` directory.
3. Push. The Dispatcher auto-discovers the run; the next PR gets a `flare-dispatch/pr-review` check, with inline annotations on the Files-changed tab.

Opt a PR out with the `skip-ai-review` label; force review on a draft with `request-ai-review`.

### Add the scheduled sweep (optional)

4. Copy [`pr-review-sweep.run.ts`](pr-review-sweep.run.ts) into `runs/` as well.
5. Add its cron to `wrangler.jsonc` — `"triggers": { "crons": ["0 3 * * *"] }` — and `wrangler deploy`. The expression must match the run's `schedules[].cron`.
6. At 03:00 UTC the Dispatcher's `scheduled()` handler instantiates the sweep; every open PR not already reviewed at its head SHA gets a `flare-dispatch/pr-review` check.
