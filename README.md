<h1 align="center">FlareDispatch</h1>

<p align="center">Offload the expensive half of GitHub Actions onto Cloudflare.</p>

<p align="center"><a href="https://flare-dispatch.openhackers.club"><b>Documentation</b></a></p>

---

BYOC CI/CD that moves the heavy compute off GitHub Actions and onto a Cloudflare stack you own — Workflows for orchestration, Containers for execution, Browser Rendering for e2e, R2 for cache and artifacts. GitHub Actions stays the trigger and PR gate; runs take the expensive jobs — agentic code review, Playwright e2e, acceptance suites, matrix fan-outs, security scans.

Runs are typed Effect-TS programs — composable steps, tagged errors, exhaustive matching — not YAML, written against a layered DSL: capabilities → primitives → recipes. `wrangler deploy` into your own Cloudflare account; no multi-tenant SaaS.

**Status** — pre-implementation; the specs are the contract.
