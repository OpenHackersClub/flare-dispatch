# 05 — BYOC Deployment (Cloudflare)

End-to-end guide to deploying runs into your own Cloudflare account — **bring-your-own-Cloud (BYOC)**, with Cloudflare as the cloud. The whole thing should take under an hour for someone familiar with Wrangler and GitHub Apps.

## Prerequisites

|                                  | Required             | Notes                                                                               |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| Cloudflare account               | Workers Paid ($5/mo) | Containers, Workflows, Browser Rendering, and useful R2 quotas are on the Paid plan |
| `wrangler` CLI                   | ≥ 4.x                | `npm i -g wrangler`                                                                 |
| `pnpm`                           | ≥ 9                  | For the run repo itself                                                             |
| Node                             | ≥ 20                 | For Wrangler                                                                        |
| GitHub org admin access          | yes                  | To install the GitHub App                                                           |
| A custom domain on CF (optional) | no                   | For a nicer endpoint URL — `*.workers.dev` works fine for v0                        |

The Paid plan is the only hard money requirement. Browser Rendering on Workers Paid includes 10 browser-hours per month and 10 concurrent browsers (averaged monthly) at no extra charge; light-to-medium use stays within that. Beyond it: $0.09 per additional browser-hour, $2.00 per additional concurrent browser.

*Source:* https://developers.cloudflare.com/browser-rendering/platform/pricing/ (2026-05).

## What you deploy

A single Worker (the Dispatcher) bound to:

- 1 × **Workflow** binding — `RUNS_WORKFLOW`
- 1 × **Container** binding — `RUNS_SANDBOX`
- 1 × **Browser Rendering** binding — `RUNS_BROWSER`
- 1 × **Durable Object** namespace — `COORDINATOR`
- 1 × **R2 bucket** — `RUNS_STORAGE`
- 1 × **D1 database** — `RUNS_METADATA`
- 3 × **KV namespaces** — `RUNS_CONFIG` (installation map, feature flags), `IDEMPOTENCY_KV` (receiver dedup, 24h TTL), `INSTALL_TOKEN_KV` (App install-token cache, 55min TTL)
- 1 × **Queue** producer + consumer — `RUNS_FANOUT`

All bindings are declared in `wrangler.jsonc`. The Dispatcher is the only entry point exposed publicly. The `/v1/admin/*` sub-path is additionally gated by a Cloudflare Access application at the edge — the Worker re-verifies the Access JWT in code, so an Access misconfiguration cannot leak the admin surface.

## Repo layout

```
flare-dispatch/                                    your fork of the template
├── wrangler.jsonc                             bindings + secrets
├── package.json
├── src/
│   ├── dispatcher.ts                          Worker entry — HMAC verify + route
│   ├── workflow.ts                            CF Workflow class (extends WorkflowEntrypoint)
│   ├── coordinator.ts                         Durable Object — fan-out state
│   ├── github.ts                              App auth + check-runs
│   └── runtime/                               Effect Layers for live CF bindings
├── runs/                                      one file per run
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

The template ships with all built-in runs wired. Users add their own under `runs/` — the Dispatcher auto-discovers them from the run registry at startup.

## Wrangler config

```jsonc
// wrangler.jsonc
{
  "name": "flare-dispatch",
  "main": "src/dispatcher.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],

  "workflows": [
    { "name": "runs-workflow", "binding": "RUNS_WORKFLOW", "class_name": "RunWorkflow" }
  ],

  "containers": [
    {
      "binding": "RUNS_SANDBOX",
      // Cloudflare Containers pulls only from registry.cloudflare.com, docker.io, or Amazon ECR.
      // GHCR is not a supported pull source — CI mirrors the GHCR image to CF's registry at release.
      "image": "registry.cloudflare.com/openhackersclub/flare-dispatch-node:latest",
      // Instance types (2026-05): lite (1/16 vCPU, 256 MiB) | basic (1/4, 1 GiB) |
      //   standard-1 (1/2, 4 GiB) | standard-2 (1, 6 GiB) | standard-3 (2, 8 GiB) | standard-4 (4, 12 GiB).
      // "standard" + "dev" are legacy aliases retained for back-compat.
      "instance_type": "standard-2",
      "max_instances": 16
    }
  ],

  "browser": { "binding": "RUNS_BROWSER" },

  "durable_objects": {
    "bindings": [
      { "name": "COORDINATOR", "class_name": "Coordinator" }
    ]
  },

  "r2_buckets": [
    { "binding": "RUNS_STORAGE", "bucket_name": "flare-dispatch-prod" }
  ],

  "d1_databases": [
    { "binding": "RUNS_METADATA", "database_name": "flare-dispatch", "database_id": "<filled by wrangler>" }
  ],

  "kv_namespaces": [
    { "binding": "RUNS_CONFIG", "id": "<filled by wrangler>" },
    { "binding": "IDEMPOTENCY_KV", "id": "<filled by wrangler>" },
    { "binding": "INSTALL_TOKEN_KV", "id": "<filled by wrangler>" }
  ],

  "queues": {
    "producers": [{ "binding": "RUNS_FANOUT", "queue": "flare-dispatch-fanout" }],
    "consumers": [{ "queue": "flare-dispatch-fanout", "max_batch_size": 10 }]
  },

  // migrations are the Durable Object lifecycle mechanism — only DO classes
  // belong here. RunWorkflow is a Workflow, registered via "workflows" above.
  "migrations": [
    { "tag": "v1", "new_classes": ["Coordinator"] }
  ],

  "observability": { "enabled": true },

  "routes": [
    { "pattern": "runs.example.com/*", "custom_domain": true }
  ]
}
```

## D1 schema

The D1 database holds execution and step metadata (the conceptual data model is in [01-architecture § Data model](01-architecture.md#data-model)). The literal schema ships as `infra/d1-schema.sql` and is applied with `wrangler d1 execute` during the deploy walkthrough below.

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY,                    -- ULID
  run TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,                   -- queued | running | success | failure | cancelled
  started_at INTEGER,                     -- ms epoch
  completed_at INTEGER,
  parent_execution_id TEXT,               -- for matrix children
  input_json TEXT NOT NULL,
  summary_json TEXT,
  check_run_id INTEGER                    -- GitHub check-run id
);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  exit_code INTEGER,
  log_uri TEXT,                           -- R2 path
  attempt INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX executions_repo_sha ON executions(repo, sha);
CREATE INDEX steps_execution ON steps(execution_id);
```

D1's 10 GB per-database limit is plenty for metadata — logs and artifacts live in R2, and D1 holds only pointers.

## Secrets

Set via `wrangler secret put` — never committed.

| Secret | What it is | How to generate | Required for |
|---|---|---|---|
| `HMAC_SECRET` | Shared with GHA Action / direct-POST callers; verifies inbound dispatches | `openssl rand -base64 32` | GHA Action path + direct-POST path. Not used by the App-webhook path. |
| `GITHUB_APP_ID` | Numeric App id | From the App's GitHub settings page | Always |
| `GITHUB_APP_PRIVATE_KEY` | PEM key for App auth | From "Generate a private key" on the App page | Always |
| `GITHUB_WEBHOOK_SECRET` | Verifies inbound App webhooks (`X-Hub-Signature-256`) | `openssl rand -base64 32`; configured in App settings | App-webhook trigger path |

```sh
wrangler secret put HMAC_SECRET                    # skip if you don't use the GHA Action / direct POST
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY < ./github-app-private-key.pem
wrangler secret put GITHUB_WEBHOOK_SECRET
```

`GITHUB_APP_PRIVATE_KEY` is large; pipe it from a file rather than typing it. After upload, delete the local PEM.

Deployments that use **only** the App-webhook trigger (no GHA Action, no external callers) can skip `HMAC_SECRET` entirely — one less long-lived shared secret to rotate. See [04-gha-integration § Secrets the user needs to configure](04-gha-integration.md#secrets-the-user-needs-to-configure).

## GitHub App setup

A manifest ships in `infra/github-app-manifest.json`:

```json
{
  "name": "FlareDispatch",
  "description": "BYOC CI offload running on Cloudflare",
  "url": "https://runs.example.com",
  "hook_attributes": {
    "url": "https://runs.example.com/v1/webhooks/github"
  },
  "redirect_url": "https://runs.example.com/v1/github/installed",
  "default_permissions": {
    "checks": "write",
    "contents": "read",
    "deployments": "read",
    "metadata": "read",
    "pull_requests": "read"
  },
  "default_events": ["check_run", "check_suite", "deployment_status", "pull_request"]
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
git clone https://github.com/openhackersclub/flare-dispatch-template my-flare-dispatch
cd my-flare-dispatch
pnpm install

# 2. Create the CF resources (Wrangler will prompt for new IDs)
wrangler r2 bucket create flare-dispatch-prod
wrangler d1 create flare-dispatch
wrangler kv namespace create RUNS_CONFIG
wrangler kv namespace create IDEMPOTENCY_KV
wrangler kv namespace create INSTALL_TOKEN_KV
wrangler queues create flare-dispatch-fanout

# Wrangler writes the IDs back into wrangler.jsonc.

# 3. Apply the D1 schema
wrangler d1 execute flare-dispatch --file infra/d1-schema.sql

# 4. Set secrets
wrangler secret put HMAC_SECRET
# (...etc — see Secrets table above)

# 5. Deploy
wrangler deploy

# 6. Verify
curl -fsS https://flare-dispatch.<your-subdomain>.workers.dev/health
# {"status":"ok","runs":["offload-test","matrix-fanout",...]}

# 7. Create the GitHub App (interactive)
pnpm cli github-app create --endpoint https://flare-dispatch.<your-subdomain>.workers.dev

# 8. Install the App on your org/repo via the URL it prints.

# 9. Test
pnpm cli dispatch offload-test --repo <your-repo> --sha <commit-sha> --command "echo hello"
```

After step 9, the Dispatcher creates a check-run on the commit and reports `success` once `echo hello` completes in a container.

### Deploying via Cloudflare Workers Builds

The Dispatcher is itself a Worker, so ongoing deploys don't have to be manual `wrangler deploy` calls. [Cloudflare Workers CI/CD (Workers Builds)](https://developers.cloudflare.com/workers/ci-cd/) can watch the FlareDispatch repo and redeploy on every push to `main` — connect the repo in the Cloudflare dashboard, point the build at `wrangler deploy`, and it manages deploy credentials for you. This is a deploy pipeline only; it does not run the FlareDispatch *runs* themselves (those execute inside Workflows + Containers on dispatch). The two operate at different layers — see [PRD § Relationship to Cloudflare Workers CI/CD](PRD.md#relationship-to-cloudflare-workers-cicd).

## CLI

`@flare-dispatch/cli` ships as a thin wrapper around the HTTP API. Used for setup, local dispatch, and ops.

```sh
flare-dispatch init                         # interactive setup; runs the wrangler/d1/kv create steps
flare-dispatch deploy                       # wrangler deploy + run migrations
flare-dispatch github-app create            # manifest-based App creation
flare-dispatch dispatch <run> ...           # send a one-off dispatch
flare-dispatch executions list              # list recent executions (D1 query)
flare-dispatch executions view <id>         # show execution details + log links
flare-dispatch logs <execution-id> <step>   # stream R2 NDJSON log
flare-dispatch runs list                    # list registered runs
```

The CLI uses `@effect/cli` and the same Effect-TS types as the run runtime — so options/args are typed, errors are tagged, and adding a subcommand is one file.

## Local development

`wrangler dev` runs the whole stack locally:

```sh
pnpm dev
# Starts Miniflare with Workflows, D1, R2, KV, Queues, and Containers (via Docker) all mocked or local.
```

What works locally:

- All Workflow logic — Miniflare implements Workflows.
- Sandbox / Containers — Wrangler launches actual Docker containers locally for the Container binding. Requires Docker running.
- R2, D1, KV, Queues — Miniflare's in-memory implementations; data resets between executions unless persisted.
- Browser Rendering — falls back to a local Puppeteer + Chromium when the binding isn't reachable. Set `RUNS_LOCAL_BROWSER=puppeteer` to enable.

What doesn't work locally:

- Inbound GitHub webhooks — use `cloudflared tunnel` or `tailscale serve` to expose `localhost:8787` for App setup testing.
- Multi-region behavior — `wrangler dev` is single-process.

The `pnpm dev` script also exposes the local Dispatcher via Tailscale Serve if available (`tailscale serve --bg 8787`), so PRs in development can dispatch to your laptop while iterating on a run.

## Operating one Dispatcher across many repos

One deploy can serve an entire org. The Dispatcher uses `installation_id` (from the dispatch body's `github.installation_id` field, signed by HMAC, validated against KV) to scope check-run writes to the right repo. There's no per-repo Worker; runs don't need to know which repo they came from beyond passing it to `sandbox.git.clone`.

To onboard a new repo:

1. Install the existing GitHub App on the new repo (via GitHub UI).
2. Set repo-level secrets: `FLAREDISPATCH_ENDPOINT`, `FLAREDISPATCH_HMAC` (org-level secrets work too).
3. Add the GHA Action to that repo's workflow.

No deploy or config change on the CF side. The first dispatch from the new repo auto-registers the installation in KV.

## Multi-environment (staging / prod)

Two Dispatcher deploys with separate bindings and HMAC secrets:

```jsonc
{
  "env": {
    "staging": {
      "r2_buckets": [{ "binding": "RUNS_STORAGE", "bucket_name": "flare-dispatch-staging" }],
      "d1_databases": [{ "binding": "RUNS_METADATA", "database_name": "flare-dispatch-staging" }],
      "routes": [{ "pattern": "runs-staging.example.com/*", "custom_domain": true }]
    },
    "prod": {
      "r2_buckets": [{ "binding": "RUNS_STORAGE", "bucket_name": "flare-dispatch-prod" }],
      "d1_databases": [{ "binding": "RUNS_METADATA", "database_name": "flare-dispatch" }],
      "routes": [{ "pattern": "runs.example.com/*", "custom_domain": true }]
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

Applied with `wrangler r2 bucket lifecycle set flare-dispatch-prod --file infra/r2-lifecycle.json` (replaces the full policy). Individual rules can be appended with `wrangler r2 bucket lifecycle add flare-dispatch-prod ...` and removed with `wrangler r2 bucket lifecycle remove flare-dispatch-prod --id <rule-id>`. There is no `wrangler r2 bucket lifecycle put` subcommand.

*Source:* https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (2026-05).

D1 has no built-in lifecycle. A nightly Cron Trigger Worker (`infra/cron-cleanup.ts`) prunes `executions` and `steps` older than 90 days. Schedule defined in `wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["0 3 * * *"] }
```

## Cost ceiling — what to expect

For a small team (200 PRs/month, ~8 min average run wall time, 4-shard matrices), expect **~$8–15/month**; at 10× volume, **~$50–100/month**. Container compute is the dominant variable cost; everything else tends to stay within the included Workers Paid quotas.

The full pricing model, per-execution cost anatomy, both worked estimates, the head-to-head with GHA list pricing, and the cost levers are in [06-cost](06-cost.md).

## Security posture

- **HMAC** on `/v1/dispatch/:run`. 32-byte secret, constant-time `crypto.subtle.verify("HMAC", ...)` (no `timingSafeEqual` — that's Node-only and isn't on Workers).
- **App webhook signature** on `/v1/webhooks/github`. `X-Hub-Signature-256` verified against `GITHUB_WEBHOOK_SECRET` with the same `crypto.subtle.verify` primitive. No shared secret with the user's GHA workflows.
- **Cloudflare Access** on `/v1/admin/*`. Worker re-verifies the Access JWT in code so a misconfigured Access app cannot leak the admin surface. The same `/v1/admin/events/:wf_id` route debounces `(wf_id, decider_email)` in `IDEMPOTENCY_KV` (1h window) so racing approvals are deterministic.
- **App installation tokens** are short-lived (1 hour TTL), scoped to one installation, refreshed on demand. Cached in `INSTALL_TOKEN_KV` with 55min TTL so the token survives Worker recycles mid-execution. No long-lived PATs.
- **R2 signed URLs** for artifacts: TTL configurable per upload (default 30 days), can be revoked by rotating the R2 access key.
- **Container isolation**: each Container instance is a fresh filesystem. No persistence between executions.
- **Workers Secrets** for all credentials. Never committed; rotated via `wrangler secret put`.
- **No outbound network egress restrictions by default** — runs can hit any external service (npm registry, GitHub for cloning, etc.). Lock down via Cloudflare Zero Trust egress rules if needed.

## What to monitor

| | Where | Threshold |
|---|---|---|
| Failed dispatches (4xx, 5xx) | Workers Analytics | > 5% over 1h → page |
| Workflow step retries | Workflows dashboard | > 10/execution → investigate flake |
| Container launch failures | D1 `steps` table, `ContainerLaunchFailed` errors | > 1% → quota / image issue |
| Browser Rendering quota | CF dashboard | > 80% of the 10 browser-hr/month included quota → consider in-container mode |
| R2 storage growth | CF dashboard | > 50GB → review lifecycle policy |
| Check-run write 4xx | App webhook log | any → installation revoked or token expired |

A `infra/grafana/` dashboard ships in V4 once OTel export is wired.

## Reference: ship-ready checklist

- [ ] Workers Paid plan active
- [ ] `wrangler.jsonc` updated with bucket / db / KV / queue IDs (three KVs: `RUNS_CONFIG`, `IDEMPOTENCY_KV`, `INSTALL_TOKEN_KV`)
- [ ] D1 schema applied
- [ ] R2 lifecycle policy applied
- [ ] Worker Secrets set (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` always; `HMAC_SECRET` if using the GHA Action / direct-POST path)
- [ ] GitHub App created and installed on target repos
- [ ] Cloudflare Access app configured for `/v1/admin/*` (if any run uses `step.waitForEvent`)
- [ ] `health` endpoint returns ok with run list
- [ ] One successful dispatch end-to-end (CLI, GHA Action, or App webhook)
- [ ] Check-run appears on the PR
- [ ] Required-status-check configured on the protected branch
- [ ] Cron cleanup Worker scheduled
