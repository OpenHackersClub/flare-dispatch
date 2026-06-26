# finops-audit

A weekly, model-written **review of execution cost** — the expensive half of a
BYOC CI/CD platform is its own runs (Worker invocations, Container minutes,
Workers-AI Neurons / gateway tokens the agentic runs burn). This Schedule-mode
run reads the account's Cloudflare usage, asks a model to surface FinOps
optimizations, and opens **one draft PR** with the write-up
(`.flare-dispatch/finops-<date>.md`). It mutates nothing — it's a signal a human
acts on.

```
weekly cron → cloudflare.usage (Workers + AI by model) → model analysis
   → draft PR with prioritized cost optimizations
```

## What it analyses

`cloudflare.usage` (a GraphQL Analytics read) returns, over the window:
- **Worker invocations + errors by script** — invocation volume and retry/error waste.
- **AI inference requests + cache-hit rate by model** — which models dominate
  spend, and where the AI Gateway cache is leaving money on the table.

The model turns that into concrete optimizations, e.g. *"glm-4.7-flash: 210
requests, 2% cache hit → cap `pr-review.agents` to single or raise the gateway
cache TTL (~70% fewer requests)"* — the exact fan-out-amplification pattern that
spikes Neuron usage.

> Today it reads account-level usage (the dispatcher is one Worker, so worker
> rows are aggregate). Per-execution cost breakdown from the D1 `executions`
> table is a natural follow-up.

## Setup

1. **Grant the read scope.** The existing `CLOUDFLARE_API_TOKEN` Worker secret
   (the one `ci-triage` uses for Pages:Read) needs **Account Analytics : Read**
   added, so `cloudflare.usage` can query the GraphQL Analytics API. Without it
   the run fails loudly (`StepFailed` naming the missing scope).
2. **Add the cron** `0 7 * * 1` to `wrangler.jsonc` `triggers.crons` (already
   wired here) and redeploy.
3. **Config (CONFIG_KV):**

| key | default | notes |
|---|---|---|
| `finops.report-repo` | — | repo to open the audit PR on (**required**) |
| `finops.base` | `main` | base branch |
| `finops.window-hours` | `168` | usage window (7 days) |
| `finops.projects` | — | optional Pages projects to flag failed deploys (wasted build minutes) |
| `finops.backend` | `workers-ai` | review engine backend (`workers-ai` \| `anthropic` \| `bedrock`) |
| `finops.workers-ai.model` | — | model id — catalog `@cf/...` or `deepseek/` reasoner (+ `.workers-ai.mode`, default `tools`) |
| `finops.prompt` | built-in | override the analysis system prompt |

Reuses the `ai-code-review` engine (`@flare-dispatch/review-agent`), so the
backend/model selection mirrors `pr-review` / `ci-triage` under the `finops.*`
namespace. No container, no model API key (the Workers AI binding is the auth).

## Output

A draft PR `chore(finops): execution-cost audit <date>` whose body is a scannable
optimization list and whose committed `.flare-dispatch/finops-<date>.md` carries
the full findings + the raw usage table. Require nothing in branch protection —
it's a review artifact, not a gate.
