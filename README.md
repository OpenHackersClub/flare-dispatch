# FlareDispatch

BYOC (Cloudflare) CI/CD runs that execute on the Cloudflare platform — Workflows for durable orchestration, Sandbox/Containers for execution, Browser Rendering for end-to-end tests, R2 for cache and artifacts.

**Not a replacement for GitHub Actions.** GHA stays as the trigger and PR gate; runs take over the heavy compute (Playwright e2e, acceptance suites, large matrix fan-outs, long-running scans) where GHA minutes are expensive and slow.

**BYOC (Cloudflare).** The expected mode is bring-your-own-Cloud — `wrangler deploy` into your own Cloudflare account. Multi-tenant SaaS is not a goal of v1; nothing in the architecture assumes someone else operates it.

**Effect-TS DSL.** Runs are typed Effect programs — composable steps, tagged errors, exhaustive matching, retry/Schedule combinators — rather than YAML.

## Specs

| | |
|---|---|
| [PRD](specs/PRD.md) | Problem, who needs this, value proposition, non-goals, roadmap |
| [01-architecture](specs/01-architecture.md) | Components, lifecycle, storage, fan-out, platform limits |
| [02-runs](specs/02-runs.md) | Run catalog with inputs/outputs/primitives |
| [03-dsl](specs/03-dsl.md) | Effect-TS DSL surface — `defineRun`, `step`, `sandbox`, `browser`, `cache`, `artifact` |
| [04-gha-integration](specs/04-gha-integration.md) | Two trigger modes (Action / Webhook), HMAC auth, check-runs callback |
| [05-byoc](specs/05-byoc.md) | Bindings, secrets, wrangler config, GitHub App, local dev |
| [06-cost](specs/06-cost.md) | Cost model, worked estimates, head-to-head with GHA pricing |
| [pm/plan](specs/pm/plan.md) | Delivery roadmap (V0–V4) and the 7-PR V0 build plan |

## Status

Pre-implementation. Specs only. See [pm/plan](specs/pm/plan.md) for the delivery roadmap and the V0 build sequence.
