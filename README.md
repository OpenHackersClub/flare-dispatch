# agentic-workflow-cf-recipes

Self-hostable CI/CD recipes that run on the Cloudflare platform — Workflows for durable orchestration, Sandbox/Containers for execution, Browser Rendering for end-to-end tests, R2 for cache and artifacts.

**Not a replacement for GitHub Actions.** GHA stays as the trigger and PR gate; recipes take over the heavy compute (Playwright e2e, acceptance suites, large matrix fan-outs, long-running scans) where GHA minutes are expensive and slow.

**Self-host first.** The expected mode is `wrangler deploy` into your own Cloudflare account. Multi-tenant SaaS is not a goal of v1; nothing in the architecture assumes someone else operates it.

**Effect-TS DSL.** Recipes are typed Effect programs — composable steps, tagged errors, exhaustive matching, retry/Schedule combinators — rather than YAML.

## Specs

| | |
|---|---|
| [00-overview](specs/00-overview.md) | Mission, non-goals, operating model, roadmap |
| [01-architecture](specs/01-architecture.md) | Components, lifecycle, storage, fan-out, platform limits |
| [02-recipes](specs/02-recipes.md) | Recipe catalog with inputs/outputs/primitives |
| [03-dsl](specs/03-dsl.md) | Effect-TS DSL surface — `defineRecipe`, `step`, `sandbox`, `browser`, `cache`, `artifact` |
| [04-gha-integration](specs/04-gha-integration.md) | GHA Action contract, HMAC auth, check-runs callback |
| [05-self-host](specs/05-self-host.md) | Bindings, secrets, wrangler config, GitHub App, local dev |
| [06-v0-plan](specs/06-v0-plan.md) | Walking-skeleton implementation plan — 7-PR sequence for `offload-test` |

## Status

Pre-implementation. Specs only. See [00-overview § Roadmap](specs/00-overview.md#roadmap) for phasing and [06-v0-plan](specs/06-v0-plan.md) for the V0 build sequence.
