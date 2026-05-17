# Recipes

Worked examples of wiring real CI use cases onto FlareDispatch. Each recipe is a copy-paste starting point — adjust the inputs and drop it into your repo.

Every recipe folder contains the typed **Run** (`*.run.ts`) and a `README.md`. Depending on the trigger mode (see [specs/04-gha-integration.md](../specs/04-gha-integration.md)) it also contains:

- **Action-mode recipe** — adds a `ci.yml` GitHub Actions workflow that dispatches the run via `openhackersclub/flaredispatch-action`. Use when the run should interleave with other GHA jobs or use GHA's native trigger filters.
- **Webhook-mode recipe** — no workflow file; the run declares its own `triggers` and the `FlareDispatch` GitHub App webhook fires it directly — zero GHA minutes. Use for autonomous runs (review on every push, post-deploy smoke).

| Recipe | Use case | Mode | Files |
|---|---|---|---|
| [browser-tests](browser-tests/) | Playwright e2e suite, sharded across the browser pool | Action | `playwright-e2e.run.ts`, `ci.yml`, `README.md` |
| [test-matrix](test-matrix/) | Same command fanned out across N shards | Action | `matrix-fanout.run.ts`, `ci.yml`, `README.md` |
| [cdp-acceptance](cdp-acceptance/) | Boot an app, drive it over CDP, assert on observations | Action | `cdp-acceptance.run.ts`, `ci.yml`, `README.md` |
| [security-scan](security-scan/) | Dependency / vulnerability scan, on PR and weekly | Action | `security-scan.run.ts`, `ci.yml`, `README.md` |
| [deploy-smoke](deploy-smoke/) | Hit critical URLs after a successful deploy | Webhook | `smoke.run.ts`, `README.md` |
| [ai-code-review](ai-code-review/) | Multi-agent AI review on every PR | Webhook | `pr-review.run.ts`, `README.md` |

The `*.run.ts` files are written against the DSL in [specs/03-dsl.md](../specs/03-dsl.md); the four Action-mode runs mirror the shipped runs catalogued in [specs/02-runs.md](../specs/02-runs.md), reproduced in each recipe so it is self-contained.

## Prerequisites

All recipes assume FlareDispatch is already deployed into your Cloudflare account and the GitHub App is installed — see [specs/05-byoc.md](../specs/05-byoc.md). Action-mode recipes additionally need two repo settings:

- `FLAREDISPATCH_ENDPOINT` (variable) — your Dispatcher URL, e.g. `https://runs.example.com`
- `FLAREDISPATCH_HMAC` (secret) — shared HMAC secret, matching the Worker's `HMAC_SECRET`

Webhook-mode recipes need neither — the GitHub App webhook signature is the only credential.
