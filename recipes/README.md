# Recipes

Worked examples of wiring real CI use cases onto FlareDispatch. Each recipe is a copy-paste starting point — adjust the inputs and drop it into your repo.

Every recipe folder ships **both triggers** for the same run, so you can wire it whichever way fits:

- **`*.run.ts`** — the typed Effect-TS run, written against the [DSL](../specs/03-dsl.md). In Webhook mode this file is the whole recipe: its `triggers` block declares the GitHub events that fire it, and the `FlareDispatch` GitHub App webhook dispatches it directly — zero GHA minutes, no workflow file needed.
- **`ci.yml`** — a GitHub Actions workflow that dispatches the same run via `openhackersclub/flare-dispatch-action`. Use Action mode when the run should interleave with other GHA jobs, needs GHA's native trigger filters, or runs in a repo where the App can't be installed.
- **`README.md`** — per-recipe notes.

The **Recommended mode** column is the default each recipe is tuned for — both files work regardless. See [specs/04-gha-integration.md](../specs/04-gha-integration.md) for the trade-offs.

| Recipe | Use case | Recommended mode | Files |
|---|---|---|---|
| [browser-tests](browser-tests/) | Playwright e2e suite, sharded across the browser pool | Action | `ci.yml`, `playwright-e2e.run.ts`, `README.md` |
| [test-matrix](test-matrix/) | Same command fanned out across N shards | Action | `ci.yml`, `matrix-fanout.run.ts`, `README.md` |
| [cdp-acceptance](cdp-acceptance/) | Boot an app, drive it over CDP, assert on observations | Action | `ci.yml`, `cdp-acceptance.run.ts`, `README.md` |
| [security-scan](security-scan/) | Dependency / vulnerability scan, on PR and weekly | Action | `ci.yml`, `security-scan.run.ts`, `README.md` |
| [deploy-smoke](deploy-smoke/) | Hit critical URLs after a successful deploy | Webhook | `smoke.run.ts`, `ci.yml`, `README.md` |
| [ai-code-review](ai-code-review/) | Multi-agent AI review on every PR | Webhook | `pr-review.run.ts`, `ci.yml`, `README.md` |

The four Action-mode `*.run.ts` files mirror the shipped runs catalogued in [specs/02-runs.md](../specs/02-runs.md), reproduced in each recipe so it is self-contained; `deploy-smoke` and `pr-review` are custom runs defined by the recipe itself.

## Prerequisites

All recipes assume FlareDispatch is already deployed into your Cloudflare account and the GitHub App is installed — see [specs/05-byoc.md](../specs/05-byoc.md). Triggering a recipe in Action mode (its `ci.yml`) additionally needs two repo settings:

- `FLAREDISPATCH_ENDPOINT` (variable) — your Dispatcher URL, e.g. `https://runs.example.com`
- `FLAREDISPATCH_HMAC` (secret) — shared HMAC secret, matching the Worker's `HMAC_SECRET`

Triggering in Webhook mode (the `*.run.ts` `triggers` block) needs neither — the GitHub App webhook signature is the only credential.
