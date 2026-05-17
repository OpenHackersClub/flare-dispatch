# Recipes

Worked examples of wiring real CI use cases onto FlareDispatch. Each recipe is a copy-paste starting point — adjust the inputs and drop it into your repo.

A recipe comes in one of two shapes, matching the two trigger modes (see [specs/04-gha-integration.md](../specs/04-gha-integration.md)):

- **Action-mode recipe** — a GitHub Actions workflow file (`ci.yml`) that calls a shipped run via `openhackersclub/flaredispatch-action`. No DSL code: the run already exists on your deploy. Use when the run should interleave with other GHA jobs or use GHA's native trigger filters.
- **Webhook-mode recipe** — a DSL run file (`*.run.ts`) you drop into your repo's `runs/`. The `FlareDispatch` GitHub App webhook fires it directly — zero GHA minutes, no workflow file. Use for autonomous runs (review on every push, post-deploy smoke).

| Recipe | Use case | Mode | Files |
|---|---|---|---|
| [browser-tests](browser-tests/) | Playwright e2e suite, sharded across the browser pool | Action | `ci.yml` |
| [test-matrix](test-matrix/) | Same command fanned out across N shards | Action | `ci.yml` |
| [cdp-acceptance](cdp-acceptance/) | Boot an app, drive it over CDP, assert on observations | Action | `ci.yml` |
| [security-scan](security-scan/) | Dependency / vulnerability scan, on PR and weekly | Action | `ci.yml` |
| [deploy-smoke](deploy-smoke/) | Hit critical URLs after a successful deploy | Webhook | `smoke.run.ts` |
| [ai-code-review](ai-code-review/) | Multi-agent AI review on every PR | Webhook | `pr-review.run.ts` + README |

The first four offload to **shipped runs** (see [specs/02-runs.md](../specs/02-runs.md)) — the recipe is just the workflow file. The last two are **custom runs** — the recipe is the DSL file.

## Prerequisites

All recipes assume FlareDispatch is already deployed into your Cloudflare account and the GitHub App is installed — see [specs/05-byoc.md](../specs/05-byoc.md). Action-mode recipes additionally need two repo settings:

- `FLAREDISPATCH_ENDPOINT` (variable) — your Dispatcher URL, e.g. `https://runs.example.com`
- `FLAREDISPATCH_HMAC` (secret) — shared HMAC secret, matching the Worker's `HMAC_SECRET`

Webhook-mode recipes need neither — the GitHub App webhook signature is the only credential.
