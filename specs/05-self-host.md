# 05 — Self-Host

End-to-end guide to deploying recipes into your own Cloudflare account. The whole thing should take under an hour for someone familiar with Wrangler and GitHub Apps.

## Prerequisites

| | Required | Notes |
|---|---|---|
| Cloudflare account | Workers Paid ($5/mo) | Containers, Workflows, Browser Rendering, and useful R2 quotas are on the Paid plan |
| `wrangler` CLI | ≥ 4.x | `npm i -g wrangler` |
| `pnpm` | ≥ 9 | For the recipe repo itself |
| Node | ≥ 20 | For Wrangler |
| GitHub org admin access | yes | To install the GitHub App |
| A custom domain on CF (optional) | no | For a nicer endpoint URL — `*.workers.dev` works fine for v0 |

The Paid plan is the only hard money requirement. Browser Rendering on Workers Paid includes 10 browser-hours per month and 10 concurrent browsers (averaged monthly) at no extra charge; light-to-medium use stays within that. Beyond it: $0.09 per additional browser-hour, $2.00 per additional concurrent browser.

*Source:* https://developers.cloudflare.com/browser-rendering/platform/pricing/ (2026-05).

## What you deploy

A single Worker (the Dispatcher) bound to:

- 1 × **Workflow** binding — `RECIPES_WORKFLOW`
- 1 × **Container** binding — `RECIPES_SANDBOX`
- 1 × **Browser Rendering** binding — `RECIPES_BROWSER`
- 1 × **Durable Object** namespace — `COORDINATOR`
- 1 × **R2 bucket** — `RECIPES_STORAGE`
- 1 × **D1 database** — `RECIPES_METADATA`
- 1 × **KV namespace** — `RECIPES_CONFIG`
- 1 × **Queue** producer + consumer — `RECIPES_FANOUT`

All bindings are declared in `wrangler.jsonc`. The Dispatcher is the only entry point exposed publicly.

## Repo layout

```
cf-recipes/                                    your fork of the template
├── wrangler.jsonc                             bindings + secrets
├── package.json
├── src/
│   ├── dispatcher.ts                          Worker entry — HMAC verify + route
│   ├── workflow.ts                            CF Workflow class (extends WorkflowEntrypoint)
│   ├── coordinator.ts                         Durable Object — fan-out state
│   ├── github.ts                              App auth + check-runs
│   └── runtime/                               Effect Layers for live CF bindings
├── recipes/                                   one file per recipe
│   ├── offload-test.ts
│   ├── matrix-fanout.ts
│   ├── playwright-e2e.ts
│   └── ...
├── packages/                                  shared Effect-TS DSL + types
│   └── core/
├── infra/
│   ├── d1-schema.sql
│   └── github-app-manifest.json
└── README.md
```

The template ships with all built-in recipes wired. Users add their own under `recipes/` — the Dispatcher auto-discovers them from the recipe registry at startup.

## Wrangler config

```jsonc
// wrangler.jsonc
{
  "name": "cf-recipes",
  "main": "src/dispatcher.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],

  "workflows": [
    { "name": "recipes-workflow", "binding": "RECIPES_WORKFLOW", "class_name": "RecipeWorkflow" }
  ],

  "containers": [
    {
      "binding": "RECIPES_SANDBOX",
      // Cloudflare Containers pulls only from registry.cloudflare.com, docker.io, or Amazon ECR.
      // GHCR is not a supported pull source — CI mirrors the GHCR image to CF's registry at release.
      "image": "registry.cloudflare.com/openhackersclub/cf-recipes-node:latest",
      // Instance types (2026-05): lite (1/16 vCPU, 256 MiB) | basic (1/4, 1 GiB) |
      //   standard-1 (1/2, 4 GiB) | standard-2 (1, 6 GiB) | standard-3 (2, 8 GiB) | standard-4 (4, 12 GiB).
      // "standard" + "dev" are legacy aliases retained for back-compat.
      "instance_type": "standard-2",
      "max_instances": 16
    }
  ],

  "browser": { "binding": "RECIPES_BROWSER" },

  "durable_objects": {
    "bindings": [
      { "name": "COORDINATOR", "class_name": "Coordinator" }
    ]
  },

  "r2_buckets": [
    { "binding": "RECIPES_STORAGE", "bucket_name": "cf-recipes-prod" }
  ],

  "d1_databases": [
    { "binding": "RECIPES_METADATA", "database_name": "cf-recipes", "database_id": "<filled by wrangler>" }
  ],

  "kv_namespaces": [
    { "binding": "RECIPES_CONFIG", "id": "<filled by wrangler>" }
  ],

  "queues": {
    "producers": [{ "binding": "RECIPES_FANOUT", "queue": "cf-recipes-fanout" }],
    "consumers": [{ "queue": "cf-recipes-fanout", "max_batch_size": 10 }]
  },

  "migrations": [
    { "tag": "v1", "new_classes": ["Coordinator", "RecipeWorkflow"] }
  ],

  "observability": { "enabled": true },

  "routes": [
    { "pattern": "recipes.example.com/*", "custom_domain": true }
  ]
}
```

## Secrets

Set via `wrangler secret put` — never committed.

| Secret | What it is | How to generate |
|---|---|---|
| `HMAC_SECRET` | Shared with GHA Action; verifies inbound dispatches | `openssl rand -base64 32` |
| `GITHUB_APP_ID` | Numeric App id | From the App's GitHub settings page |
| `GITHUB_APP_PRIVATE_KEY` | PEM key for App auth | From "Generate a private key" on the App page |
| `GITHUB_WEBHOOK_SECRET` | Verifies inbound webhook events from GitHub | `openssl rand -base64 32`; configured in App settings |

```sh
wrangler secret put HMAC_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY < ./github-app-private-key.pem
wrangler secret put GITHUB_WEBHOOK_SECRET
```

`GITHUB_APP_PRIVATE_KEY` is large; pipe it from a file rather than typing it. After upload, delete the local PEM.

## GitHub App setup

A manifest ships in `infra/github-app-manifest.json`:

```json
{
  "name": "CF Recipes",
  "description": "Self-hosted CI offload to Cloudflare",
  "url": "https://recipes.example.com",
  "hook_attributes": {
    "url": "https://recipes.example.com/v1/github/webhook"
  },
  "redirect_url": "https://recipes.example.com/v1/github/installed",
  "default_permissions": {
    "checks": "write",
    "contents": "read",
    "metadata": "read",
    "pull_requests": "read"
  },
  "default_events": ["check_run", "check_suite", "pull_request"]
}
```

Setup:

1. POST the manifest to `https://github.com/settings/apps/new?state=<random>` (or use GitHub's "Create from manifest" flow).
2. GitHub redirects to your endpoint with a code; the Dispatcher exchanges it for the App credentials and prints them.
3. Stash `app_id`, `webhook_secret`, and `private_key` into Worker Secrets.
4. Install the App on the org or specific repos you want to use it with.
5. Each installation's `installation_id` is auto-discovered from webhooks; you don't have to record it manually.

## First deploy walkthrough

```sh
# 1. Clone the template
git clone https://github.com/openhackersclub/cf-recipes-template my-cf-recipes
cd my-cf-recipes
pnpm install

# 2. Create the CF resources (Wrangler will prompt for new IDs)
wrangler r2 bucket create cf-recipes-prod
wrangler d1 create cf-recipes
wrangler kv namespace create RECIPES_CONFIG
wrangler queues create cf-recipes-fanout

# Wrangler writes the IDs back into wrangler.jsonc.

# 3. Apply the D1 schema
wrangler d1 execute cf-recipes --file infra/d1-schema.sql

# 4. Set secrets
wrangler secret put HMAC_SECRET
# (...etc — see Secrets table above)

# 5. Deploy
wrangler deploy

# 6. Verify
curl -fsS https://cf-recipes.<your-subdomain>.workers.dev/health
# {"status":"ok","recipes":["offload-test","matrix-fanout",...]}

# 7. Create the GitHub App (interactive)
pnpm cli github-app create --endpoint https://cf-recipes.<your-subdomain>.workers.dev

# 8. Install the App on your org/repo via the URL it prints.

# 9. Test
pnpm cli dispatch offload-test --repo <your-repo> --sha <commit-sha> --command "echo hello"
```

After step 9, the Dispatcher creates a check-run on the commit and reports `success` once `echo hello` completes in a container.

## CLI

`@cf-recipes/cli` ships as a thin wrapper around the HTTP API. Used for setup, local dispatch, and ops.

```sh
cf-recipes init                    # interactive setup; runs the wrangler/d1/kv create steps
cf-recipes deploy                  # wrangler deploy + run migrations
cf-recipes github-app create       # manifest-based App creation
cf-recipes dispatch <recipe> ...   # send a one-off dispatch
cf-recipes runs list               # list recent runs (D1 query)
cf-recipes runs view <id>          # show run details + log links
cf-recipes logs <run-id> <step>    # stream R2 NDJSON log
cf-recipes recipes list            # list registered recipes
```

The CLI uses `@effect/cli` and the same Effect-TS types as the recipe runtime — so options/args are typed, errors are tagged, and adding a subcommand is one file.

## Local development

`wrangler dev` runs the whole stack locally:

```sh
pnpm dev
# Starts Miniflare with Workflows, D1, R2, KV, Queues, and Containers (via Docker) all mocked or local.
```

What works locally:

- All Workflow logic — Miniflare implements Workflows.
- Sandbox / Containers — Wrangler launches actual Docker containers locally for the Container binding. Requires Docker running.
- R2, D1, KV, Queues — Miniflare's in-memory implementations; data resets between runs unless persisted.
- Browser Rendering — falls back to a local Puppeteer + Chromium when the binding isn't reachable. Set `RECIPES_LOCAL_BROWSER=puppeteer` to enable.

What doesn't work locally:

- Inbound GitHub webhooks — use `cloudflared tunnel` or `tailscale serve` to expose `localhost:8787` for App setup testing.
- Multi-region behavior — `wrangler dev` is single-process.

The `pnpm dev` script also exposes the local Dispatcher via Tailscale Serve if available (`tailscale serve --bg 8787`), so PRs in development can dispatch to your laptop while iterating on a recipe. See `## Dev Servers — Expose via Tailscale Serve` in the project CLAUDE.md.

## Operating one Dispatcher across many repos

One deploy can serve an entire org. The Dispatcher uses `installation_id` (from the dispatch body's `github.installation_id` field, signed by HMAC, validated against KV) to scope check-run writes to the right repo. There's no per-repo Worker; recipes don't need to know which repo they came from beyond passing it to `sandbox.git.clone`.

To onboard a new repo:

1. Install the existing GitHub App on the new repo (via GitHub UI).
2. Set repo-level secrets: `CF_RECIPES_ENDPOINT`, `CF_RECIPES_HMAC` (org-level secrets work too).
3. Add the GHA Action to that repo's workflow.

No deploy or config change on the CF side. The first dispatch from the new repo auto-registers the installation in KV.

## Multi-environment (staging / prod)

Two Dispatcher deploys with separate bindings and HMAC secrets:

```jsonc
{
  "env": {
    "staging": {
      "r2_buckets": [{ "binding": "RECIPES_STORAGE", "bucket_name": "cf-recipes-staging" }],
      "d1_databases": [{ "binding": "RECIPES_METADATA", "database_name": "cf-recipes-staging" }],
      "routes": [{ "pattern": "recipes-staging.example.com/*", "custom_domain": true }]
    },
    "prod": {
      "r2_buckets": [{ "binding": "RECIPES_STORAGE", "bucket_name": "cf-recipes-prod" }],
      "d1_databases": [{ "binding": "RECIPES_METADATA", "database_name": "cf-recipes" }],
      "routes": [{ "pattern": "recipes.example.com/*", "custom_domain": true }]
    }
  }
}
```

```sh
wrangler deploy --env staging
wrangler deploy --env prod
```

GHA workflows reference the appropriate endpoint via env secrets.

## Retention and cleanup

R2 lifecycle policy in `infra/r2-lifecycle.json`:

```json
{
  "rules": [
    { "prefix": "cache/", "expiration": { "days": 30 } },
    { "prefix": "artifacts/", "expiration": { "days": 90 } },
    { "prefix": "logs/", "expiration": { "days": 14 } }
  ]
}
```

Applied with `wrangler r2 bucket lifecycle set cf-recipes-prod --file infra/r2-lifecycle.json` (replaces the full policy). Individual rules can be appended with `wrangler r2 bucket lifecycle add cf-recipes-prod ...` and removed with `wrangler r2 bucket lifecycle remove cf-recipes-prod --id <rule-id>`. There is no `wrangler r2 bucket lifecycle put` subcommand.

*Source:* https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (2026-05).

D1 has no built-in lifecycle. A nightly Cron Trigger Worker (`infra/cron-cleanup.ts`) prunes `runs` and `steps` older than 90 days. Schedule defined in `wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["0 3 * * *"] }
```

## Cost ceiling — what to expect

For a small team (200 PRs/month, ~8min average recipe wall time, 4-shard matrices):

| Line item | Estimate |
|---|---|
| Workers Paid | $5 (base; includes 10M requests + 30M CPU-ms / month, then $0.30/1M req and $0.02/1M CPU-ms) |
| Workers requests | within included quota |
| Containers (vCPU-s + memory + disk) | $3-8 above the included 375 vCPU-min + 25 GiB-h + 200 GB-h on the $5 plan ($0.000020/vCPU-s, $0.0000025/GiB-s, $0.00000007/GB-s thereafter) |
| Browser Rendering | within included 10 browser-hr/month + 10 concurrent-browser-month included (then $0.09/hr, $2.00/extra concurrent browser) |
| R2 storage (~5GB cache + artifacts) | ~$0.08 |
| R2 ops + lifecycle expirations | within free tier |
| D1 | within free tier (10 GB per database, 1 TB account storage on Paid) |
| Queues | within free tier |
| **Total** | **~$8-15 / month** |

Same calculus, 10× volume → $50-100/month. Both numbers compare favorably to GHA list pricing on heavy jobs (see prior economic comparison).

*Source:* [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/), [Browser Rendering pricing](https://developers.cloudflare.com/browser-rendering/platform/pricing/). 2026-05.

## Security posture

- **HMAC** on the dispatch path. 32-byte secret, constant-time comparison, rejects on any mismatch.
- **GitHub webhook secret** on the callback path. Same crypto, separate secret.
- **App installation tokens** are short-lived (1 hour TTL), scoped to one installation, refreshed on demand. No long-lived PATs.
- **R2 signed URLs** for artifacts: TTL configurable per upload (default 30 days), can be revoked by rotating the R2 access key.
- **Container isolation**: each Container instance is a fresh filesystem. No persistence between recipe runs.
- **Workers Secrets** for all credentials. Never committed; rotated via `wrangler secret put`.
- **No outbound network egress restrictions by default** — recipes can hit any external service (npm registry, GitHub for cloning, etc.). Lock down via Cloudflare Zero Trust egress rules if needed.

## What to monitor

| | Where | Threshold |
|---|---|---|
| Failed dispatches (4xx, 5xx) | Workers Analytics | > 5% over 1h → page |
| Workflow step retries | Workflows dashboard | > 10/run → investigate flake |
| Container launch failures | D1 `steps` table, `ContainerLaunchFailed` errors | > 1% → quota / image issue |
| Browser Rendering quota | CF dashboard | > 80% of the 10 browser-hr/month included quota → consider in-container mode |
| R2 storage growth | CF dashboard | > 50GB → review lifecycle policy |
| Check-run write 4xx | App webhook log | any → installation revoked or token expired |

A `infra/grafana/` dashboard ships in V4 once OTel export is wired.

## Reference: ship-ready checklist

- [ ] Workers Paid plan active
- [ ] `wrangler.jsonc` updated with bucket / db / KV / queue IDs
- [ ] D1 schema applied
- [ ] R2 lifecycle policy applied
- [ ] All four Worker Secrets set
- [ ] GitHub App created and installed on target repos
- [ ] `health` endpoint returns ok with recipe list
- [ ] One successful dispatch end-to-end (CLI or via PR)
- [ ] Check-run appears on the PR
- [ ] Required-status-check configured on the protected branch
- [ ] Cron cleanup Worker scheduled
