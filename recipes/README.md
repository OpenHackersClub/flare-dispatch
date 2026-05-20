# Recipes

Worked examples of wiring real CI use cases onto FlareDispatch. Each recipe is a copy-paste starting point — adjust the inputs and drop it into your repo.

A recipe is **logic riding on primitives**. The DSL is layered — capabilities → [primitives](../packages/core/src/primitives/) → recipes (see [03-dsl § The layering](../specs/03-dsl.md#the-layering-capabilities-primitives-recipes)) — so a recipe imports the reusable shapes (`workspace`, `installCached`, `sharded`, `bootApp`, `probeHttp`) from `@flare-dispatch/core/primitives` and carries only the logic unique to *that* use case. The two import paths at the top of each `*.run.ts` keep the boundary visible:

```ts
import { defineRun, step, sandbox, artifact } from "@flare-dispatch/core";
import { workspace, sharded } from "@flare-dispatch/core/primitives";
```

When a recipe needs something no primitive covers, it drops to raw capabilities — the escape hatch is always open.

A recipe folder holds the run plus whatever its [trigger mode](../specs/04-gha-integration.md) needs:

- **`*.run.ts`** — the typed Effect-TS run, written against the [DSL](../specs/03-dsl.md). In Webhook mode this file is the whole recipe: its `triggers` block declares the GitHub events that fire it, and the `FlareDispatch` GitHub App webhook dispatches it directly — zero GHA minutes, no workflow file needed. A run whose trigger is a wall-clock cadence instead declares a `schedules` block (Schedule mode) — a Cloudflare Cron Trigger fires it, again with no workflow file.
- **`ci.yml`** — a GitHub Actions workflow that dispatches the run via `openhackersclub/flare-dispatch-action`. Present only for recipes whose recommended mode is Action; Webhook- and Schedule-mode recipes don't need one. Use Action mode when the run should interleave with other GHA jobs, needs GHA's native trigger filters, or runs in a repo where the App can't be installed.
- **`README.md`** — per-recipe notes.

The **Recommended mode** column is the default each recipe is tuned for. See [specs/04-gha-integration.md](../specs/04-gha-integration.md) for the trade-offs.

| Recipe | Use case | Recommended mode | Files |
|---|---|---|---|
| [ai-code-review](ai-code-review/) | Multi-agent agentic code review on every PR, plus an optional nightly sweep of open PRs | Webhook (+ Schedule) | `pr-review.run.ts`, `pr-review-sweep.run.ts`, `ci.yml`, `README.md` |
| [browser-tests](browser-tests/) | Playwright e2e suite, sharded across the browser pool | Action | `ci.yml`, `playwright-e2e.run.ts`, `README.md` |
| [test-matrix](test-matrix/) | Same command fanned out across N shards | Action | `ci.yml`, `matrix-fanout.run.ts`, `README.md` |
| [cdp-acceptance](cdp-acceptance/) | Boot an app, drive it over CDP, assert on observations | Action | `ci.yml`, `cdp-acceptance.run.ts`, `README.md` |
| [product-demo](product-demo/) | AI-driven walkthrough video of a deployed site, with a per-story summary | Action | `ci.yml`, `product-demo.run.ts`, `README.md` |
| [security-scan](security-scan/) | Dependency / vulnerability scan, on PR and weekly | Action | `ci.yml`, `security-scan.run.ts`, `README.md` |
| [deploy-smoke](deploy-smoke/) | Hit critical URLs after a successful deploy | Webhook | `smoke.run.ts`, `ci.yml`, `README.md` |
| [nightly-e2e](nightly-e2e/) | Nightly Playwright suite across your deployed environments | Schedule | `nightly-e2e.run.ts`, `README.md` |
| [release-notes](release-notes/) | Weekly release notes drafted, then published behind a human approval | Schedule | `release-notes.run.ts`, `README.md` |
| [scheduled-deps](scheduled-deps/) | Nightly dependency audit across every installed repo | Schedule | `scheduled-deps.run.ts`, `README.md` |

The Action-mode `*.run.ts` files mirror the shipped runs catalogued in [specs/02-runs.md](../specs/02-runs.md), reproduced in each recipe so it is self-contained. The Webhook- and Schedule-mode recipes — `deploy-smoke`, `pr-review`, `pr-review-sweep`, `nightly-e2e`, `release-notes`, `scheduled-deps` — are custom runs defined by the recipe itself; the three Schedule-mode runs are thin orchestration that dispatch shipped runs (`playwright-e2e`, `security-scan`) or, for `release-notes`, shell out to a bundled CLI.

## Prerequisites

All recipes assume FlareDispatch is already deployed into your Cloudflare account and the GitHub App is installed — see [specs/05-byoc.md](../specs/05-byoc.md). Triggering a recipe in Action mode (its `ci.yml`) additionally needs two repo settings:

- `FLAREDISPATCH_ENDPOINT` (variable) — your Dispatcher URL, e.g. `https://runs.example.com`
- `FLAREDISPATCH_HMAC` (secret) — shared HMAC secret, matching the Worker's `HMAC_SECRET`

Triggering in Webhook mode (the `*.run.ts` `triggers` block) needs neither — the GitHub App webhook signature is the only credential.

Triggering in Schedule mode (the `*.run.ts` `schedules` block) needs neither shared secret either, but every cron expression a run declares must also be listed in `wrangler.jsonc` `triggers.crons` — that array is what Cloudflare subscribes to. See [specs/05-byoc.md § Wrangler config](../specs/05-byoc.md#wrangler-config).
