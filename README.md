# FlareDispatch

BYOC CI/CD that offloads the expensive half of CI onto Cloudflare — Workflows for orchestration, Sandbox/Containers for execution, Browser Rendering for e2e tests, R2 for cache and artifacts.

GitHub Actions stays the trigger and PR gate; runs take the heavy compute — Playwright e2e, acceptance suites, large matrix fan-outs, long-running scans. Runs are typed Effect-TS programs (composable steps, tagged errors, exhaustive matching), not YAML, and `wrangler deploy` into your own Cloudflare account — no multi-tenant SaaS.

**Docs site → [flaredispatch.openhackers.club](https://flaredispatch.openhackers.club)** — specs and recipes, deployed from `apps/docs/` to Cloudflare Pages on every push to `main`.

## Specs

| | |
|---|---|
| [Product Requirements](https://flaredispatch.openhackers.club/docs/prd) | Problem, value proposition, non-goals, roadmap |
| [Architecture](https://flaredispatch.openhackers.club/docs/01-architecture) | Components, lifecycle, storage, fan-out, platform limits |
| [Runs](https://flaredispatch.openhackers.club/docs/02-runs) | Run catalog — inputs, outputs, CF primitives |
| [DSL](https://flaredispatch.openhackers.club/docs/03-dsl) | Effect-TS DSL — `defineRun`, `step`, `sandbox`, `browser`, `cache`, `artifact` |
| [GHA Integration](https://flaredispatch.openhackers.club/docs/04-gha-integration) | Trigger modes (Action / Webhook), HMAC auth, check-runs callback |
| [BYOC Deployment](https://flaredispatch.openhackers.club/docs/05-byoc) | Bindings, secrets, wrangler config, GitHub App, local dev |
| [Cost](https://flaredispatch.openhackers.club/docs/06-cost) | Cost model, worked estimates, head-to-head with GHA pricing |
| [Roadmap & V0 Plan](https://flaredispatch.openhackers.club/docs/pm/plan) | Delivery roadmap (V0–V4) and the 7-PR V0 build plan |

## Recipes

Copy-paste [recipes](https://flaredispatch.openhackers.club/recipes) for real CI use cases — browser tests, test matrices, CDP acceptance, security scans, deploy smoke, AI code review. Each ships both a GitHub Actions workflow and a typed run.

## Status

Pre-implementation — specs only. See the [roadmap](https://flaredispatch.openhackers.club/docs/pm/plan) for the V0 build sequence.
