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

| Binding | Type | Status |
|---|---|---|
| `RUNS_WORKFLOW` | Workflow | Live |
| `RUNS_SANDBOX` | Container (Durable Object) | Live |
| `RUNS_STORAGE` | R2 bucket | Live |
| `RUNS_METADATA` | D1 database | Live |
| `CONFIG_KV` | KV namespace (dynamic config + `loadSecrets` secret store) | Live |
| `triggers.crons` | Cron Triggers (Schedule mode heartbeat) | Live |
| `RUNS_BROWSER` | Browser Rendering | **Planned (V2)** — `cdp-acceptance` today uses operator-pinned `BROWSER_CDP_CONNECT_URL` + `BROWSER_CDP_API_TOKEN` Worker secrets (the container, not the Worker, opens the CDP WebSocket). |
| `COORDINATOR` | Durable Object namespace | **Planned (V1)** — fan-out result aggregation, lands with `matrix-fanout`. |
| `IDEMPOTENCY_KV` | KV namespace (receiver dedup, 24h TTL) | **Planned (V1)** — lands with the Webhook-mode receiver. |
| `INSTALL_TOKEN_KV` | KV namespace (App install-token cache, 55min TTL) | **Planned (V1)** — V0 caches install tokens in Worker memory only. |
| `RUNS_FANOUT` | Queue producer + consumer | **Planned (V1)** — engaged only at very high shard counts. |

All live bindings are declared in `wrangler.jsonc`, alongside a `triggers.crons` array — not a binding, but the Cron Triggers that drive Schedule-mode runs. The Dispatcher is the only entry point exposed publicly. A `/v1/admin/*` sub-path (operator surface — force-cancel, replay, `step.waitForEvent` signalling) gated by Cloudflare Access is **Planned (V2/V3)** — see [01-architecture § Dispatcher Worker](01-architecture.md#control-plane) and [07-trust-model § Controls](07-trust-model.md#controls-in-place).

The retention sweep (`infra/cron-cleanup.ts`) referenced in [§ Retention and cleanup](#retention-and-cleanup) is also **Planned (V4)** — at HEAD `apps/dispatcher/src/routes/scheduled.ts` only routes cron ticks to runs whose `schedules[].cron` matches.

## Repo layout

The actual layout at HEAD (a pnpm workspace, not a flat `src/`):

```
flare-dispatch/                                    your fork of the template
├── wrangler.jsonc                             bindings + Cron Triggers
├── package.json                               pnpm workspace root
├── pnpm-workspace.yaml
├── apps/
│   └── dispatcher/                            the Worker
│       └── src/
│           ├── index.ts                       Worker entry (fetch + scheduled)
│           ├── router.ts                      HTTP path/method routing
│           ├── routes/
│           │   ├── dispatch.ts                POST /v1/dispatch/:run (HMAC verify)
│           │   ├── artifacts.ts               GET /v1/artifacts/:execution/:name
│           │   ├── github.ts                  GET /v1/github/install/new + /installed
│           │   ├── health.ts                  GET /health
│           │   └── scheduled.ts               Cron Trigger → scheduling Workflow
│           ├── hmac.ts                        constant-time HMAC verify (raw-bytes contract)
│           ├── workflow.ts                    RunWorkflow class (extends WorkflowEntrypoint)
│           ├── sandbox.ts                     RunSandbox DO (container binding class)
│           ├── registry.ts                    run-name → Run map; schedulesByCron()
│           └── env.ts                         typed binding Env
├── packages/                                  Effect-TS DSL + live Layers + CLI
│   ├── core/                                  @flare-dispatch/core — DSL + primitives + fakes
│   ├── runtime-cf/                            live CF binding Layers
│   ├── github-app/                            App JWT + install token + check-runs
│   └── cli/                                   @flare-dispatch/cli — dispatch + github-app create
├── runs/                                      one file per run
│   ├── offload-test.ts                        V0
│   ├── cdp-acceptance.ts                      V2 (PR9)
│   └── product-demo.ts                        Schedule-mode demo run
├── recipes/                                   starter library — copy-paste, not a dependency
├── actions/
│   └── flare-dispatch-action/                 GHA composite Action (bundled JS)
├── infra/
│   ├── d1-schema.sql
│   ├── Dockerfile.sandbox                     container image baked from @cloudflare/sandbox
│   └── github-app-manifest.json
└── specs/                                     these docs
```

Runs declared in `apps/dispatcher/src/registry.ts` are dispatch-able. Adding a new run today means: drop a file under `runs/`, re-export it from `runs/index.ts`, and register it in `apps/dispatcher/src/registry.ts`. Auto-discovery is **Planned (V4)** — currently the registry is a hand-written map.

## Wrangler config

The shape at HEAD (`wrangler.jsonc` on `main`) ships only the **live** bindings. The Planned bindings (`RUNS_BROWSER`, `COORDINATOR`, `IDEMPOTENCY_KV`, `INSTALL_TOKEN_KV`, `RUNS_FANOUT`) land alongside the features that consume them — V1 for fan-out + receiver dedup, V2 for the Browser Rendering binding (`cdp-acceptance` today uses `BROWSER_CDP_*` Worker secrets instead, see [§ Secrets](#secrets)).

```jsonc
// wrangler.jsonc — V0/V3 live config
{
  "name": "flare-dispatch-v0",
  "main": "apps/dispatcher/src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],

  "observability": { "enabled": true },

  "workflows": [
    { "name": "runs-workflow", "binding": "RUNS_WORKFLOW", "class_name": "RunWorkflow" }
  ],

  // Container binding. The `@cloudflare/sandbox` SDK's Sandbox DO speaks an
  // RPC protocol to a server baked into the container, so the image is built
  // from the matching `docker.io/cloudflare/sandbox` base via a Dockerfile
  // (infra/Dockerfile.sandbox) — a bare node image has no sandbox server.
  // Cloudflare Containers pulls only from registry.cloudflare.com, docker.io,
  // or Amazon ECR; the Dockerfile's FROM resolves docker.io.
  "containers": [
    {
      "class_name": "RunSandbox",
      "image": "./infra/Dockerfile.sandbox",
      // Instance types (2026-05): lite (1/16 vCPU, 256 MiB) | basic (1/4, 1 GiB) |
      //   standard-1 (1/2, 4 GiB) | standard-2 (1, 6 GiB) | standard-3 (2, 8 GiB) | standard-4 (4, 12 GiB).
      "instance_type": "standard-2",
      "max_instances": 16
    }
  ],

  // The Container runtime is fronted by a Durable Object class. RunSandbox is the
  // DO class backing the RUNS_SANDBOX container binding (NOT the Coordinator
  // fan-out DO, which is Planned for V1).
  "durable_objects": {
    "bindings": [
      { "name": "RUNS_SANDBOX", "class_name": "RunSandbox" }
    ]
  },

  "migrations": [
    { "tag": "v0", "new_sqlite_classes": ["RunSandbox"] }
  ],

  "r2_buckets": [
    { "binding": "RUNS_STORAGE", "bucket_name": "flare-dispatch-v0" }
  ],

  "d1_databases": [
    { "binding": "RUNS_METADATA", "database_name": "flare-dispatch-v0", "database_id": "<filled by wrangler>" }
  ],

  // KV namespace backing the `config` capability + `loadSecrets` primitive.
  // Provision with `wrangler kv namespace create CONFIG_KV` and paste the id.
  "kv_namespaces": [
    { "binding": "CONFIG_KV", "id": "<filled by wrangler>" }
  ],

  // Cron Triggers — the heartbeat for Schedule-mode runs (04-gha-integration
  // § Schedule mode). Every cron expression a run's `schedules` declares MUST
  // appear in this array — it is what Cloudflare actually subscribes to; the
  // Worker's `scheduled()` handler then routes `controller.cron` to the
  // matching run(s) via `schedulesByCron`. Multiple runs may share one expression.
  "triggers": {
    "crons": ["0 14 * * *"]
  }
}
```

### Planned wrangler entries (V1+)

These entries land with the features that consume them — keep them out of `wrangler.jsonc` until the consumer exists, or `wrangler deploy --dry-run` will reject the unused binding.

```jsonc
// Planned — V1 fan-out + receiver dedup + V2 Browser Rendering.
{
  "browser": { "binding": "RUNS_BROWSER" },                            // V2 — cdp-acceptance currently uses BROWSER_CDP_* secrets

  "durable_objects": {
    "bindings": [
      { "name": "RUNS_SANDBOX", "class_name": "RunSandbox" },
      { "name": "COORDINATOR", "class_name": "Coordinator" }           // V1 — fan-out aggregator
    ]
  },

  "kv_namespaces": [
    { "binding": "CONFIG_KV", "id": "..." },
    { "binding": "IDEMPOTENCY_KV", "id": "..." },                      // V1 — receiver dedup
    { "binding": "INSTALL_TOKEN_KV", "id": "..." }                     // V1 — install token cache
  ],

  "queues": {
    "producers": [{ "binding": "RUNS_FANOUT", "queue": "flare-dispatch-fanout" }],
    "consumers": [{ "queue": "flare-dispatch-fanout", "max_batch_size": 10 }]
  },

  "migrations": [
    { "tag": "v0", "new_sqlite_classes": ["RunSandbox"] },
    { "tag": "v1", "new_classes": ["Coordinator"] }
  ],

  "routes": [
    { "pattern": "runs.example.com/*", "custom_domain": true }          // custom domain — DNS, not code
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
| `OIDC_SIGNING_JWK` | The Dispatcher's OIDC issuer key (private JWK, ES256). Public half is auto-served at `/.well-known/jwks.json` | `pnpm cli oidc keygen` (writes a fresh P-256 private JWK to stdout) | Any run that uses the `oidc` capability or the `awsAssumeRole` primitive. Skip if no run federates. |

```sh
wrangler secret put HMAC_SECRET                    # skip if you don't use the GHA Action / direct POST
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY < ./github-app-private-key.pem
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put OIDC_SIGNING_JWK < ./oidc-signing.jwk.json    # only if you federate to AWS/GCP/Vault
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

1. Visit `<your-endpoint>/v1/github/install/new` in a browser (the `pnpm --filter @flare-dispatch/cli cli github-app create --endpoint <url>` subcommand prints this URL for you). The Dispatcher renders a self-submitting form that POSTs the manifest to `https://github.com/settings/apps/new?state=<csrf>` — the placeholder `runs.example.com` URLs in `infra/github-app-manifest.json` are substituted with the Dispatcher's own origin at request time.
2. GitHub redirects to `<your-endpoint>/v1/github/installed?code=<code>`; the Dispatcher exchanges the code at `POST /app-manifests/<code>/conversions` and renders a one-shot "Success" page with the credentials and the `wrangler secret put` commands you need to run.
3. Stash `app_id`, `webhook_secret`, `private_key`, `client_id`, and `client_secret` into Worker Secrets — they are shown ONCE.
4. Install the App on the org or specific repos you want to use it with via the install link the success page surfaces.
5. Each installation's `installation_id` is auto-discovered from webhooks; you don't have to record it manually. **(Planned, V1 — the webhook receiver populates the installation map; at HEAD operators pass `installation-id` explicitly to the GHA Action.)**

> **Security note: the `state` CSRF token is generated at step 1 but not yet bound to KV at step 2** — the callback echoes it back, but the Dispatcher does not currently reject an unminted state. Tracked as a high-severity gap in [07-trust-model § Known gaps](07-trust-model.md#known-gaps).

## AWS federation trust policy

Runs that need AWS credentials (Bedrock `InvokeModel`, S3 mirroring, KMS unwrap, …) reach for `awsAssumeRole` ([03-dsl § `awsAssumeRole`](03-dsl.md#awsassumerole)) — the workload-identity-federation pattern that keeps long-lived AWS keys out of Worker Secrets. The IAM trust policy on each role pins the Dispatcher's stable issuer URL and pins the `sub` claim to scope the role to a specific run.

```sh
# 1. Register the Dispatcher as an OIDC provider in AWS (one-time, per AWS account).
aws iam create-open-id-connect-provider \
  --url https://flare-dispatch.<your-subdomain>.workers.dev \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list <sha1-of-jwks-tls-leaf-cert>
```

```json5
// 2. Trust policy attached to e.g. role/FlareDispatchBedrockReader.
// `Federated` is the provider ARN from step 1. The `sub` condition pins the
// role to one named run — the Dispatcher's `oidc.sign` defaults `subject` to
// `<run-name>:<execution-id>`, so `StringLike` with a wildcard on the
// execution id is the usual shape.
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789012:oidc-provider/flare-dispatch.<your-subdomain>.workers.dev"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "flare-dispatch.<your-subdomain>.workers.dev:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "flare-dispatch.<your-subdomain>.workers.dev:sub": "ai-code-review:*"
      }
    }
  }]
}
```

The Dispatcher's issuer URL is its origin — no path. JWKS lives at `/.well-known/jwks.json`; AWS rotates its cached key set automatically when a new `kid` appears. Rotating the signing key is `pnpm cli oidc keygen | wrangler secret put OIDC_SIGNING_JWK` followed by a redeploy; AWS picks up the new key on the next token exchange.

The same pattern federates against **GCP STS** (Workload Identity Federation pool) and **HashiCorp Vault** (`auth/jwt`); only the `audience` and trust-policy shape change. The `oidc` capability is provider-agnostic — `awsAssumeRole` is the first primitive on it because Bedrock was the first downstream consumer that needed it.

## First deploy walkthrough

```sh
# 1. Clone the template
git clone https://github.com/openhackersclub/flare-dispatch-template my-flare-dispatch
cd my-flare-dispatch
pnpm install

# 2. Create the CF resources (Wrangler will prompt for new IDs).
# At V0 only CONFIG_KV is required; IDEMPOTENCY_KV / INSTALL_TOKEN_KV /
# RUNS_FANOUT land in V1 alongside the features that need them.
wrangler r2 bucket create flare-dispatch-v0
wrangler d1 create flare-dispatch-v0
wrangler kv namespace create CONFIG_KV

# Wrangler writes the IDs back into wrangler.jsonc.

# 3. Apply the D1 schema
wrangler d1 execute flare-dispatch-v0 --file infra/d1-schema.sql

# 4. Set secrets
wrangler secret put HMAC_SECRET
# (...etc — see Secrets table above)

# 5. Deploy
wrangler deploy

# 6. Verify
curl -fsS https://flare-dispatch-v0.<your-subdomain>.workers.dev/health
# {"status":"ok","runs":["cdp-acceptance","offload-test","product-demo"]}

# 7. Create the GitHub App (interactive)
pnpm --filter @flare-dispatch/cli cli github-app create \
  --endpoint https://flare-dispatch-v0.<your-subdomain>.workers.dev

# 8. Install the App on your org/repo via the URL it prints.

# 9. Test — dispatch via the CLI (env-var driven, mirrors the GHA Action contract)
INPUT_RUN=offload-test \
INPUT_ENDPOINT=https://flare-dispatch-v0.<your-subdomain>.workers.dev \
INPUT_HMAC_SECRET=$HMAC_SECRET \
INPUT_INPUTS='{"repo":"owner/test-repo","sha":"<sha>","command":"echo hello"}' \
GITHUB_REPOSITORY=owner/test-repo GITHUB_SHA=<sha> \
  pnpm --filter @flare-dispatch/cli cli dispatch
```

After step 9, the Dispatcher creates a check-run on the commit and reports `success` once `echo hello` completes in a container.

### Deploying via Cloudflare Workers Builds

The Dispatcher is itself a Worker, so ongoing deploys don't have to be manual `wrangler deploy` calls. [Cloudflare Workers CI/CD (Workers Builds)](https://developers.cloudflare.com/workers/ci-cd/) can watch the FlareDispatch repo and redeploy on every push to `main` — connect the repo in the Cloudflare dashboard, point the build at `wrangler deploy`, and it manages deploy credentials for you. This is a deploy pipeline only; it does not run the FlareDispatch *runs* themselves (those execute inside Workflows + Containers on dispatch). The two operate at different layers — see [PRD § Relationship to Cloudflare Workers CI/CD](PRD.md#relationship-to-cloudflare-workers-cicd).

## CLI

`@flare-dispatch/cli` ships as a thin wrapper around the HTTP API. Used for setup, local dispatch, and ops.

| Subcommand | Status | Notes |
|---|---|---|
| `dispatch` | Live | Env-var driven (`INPUT_RUN`, `INPUT_ENDPOINT`, `INPUT_HMAC_SECRET`, `INPUT_INPUTS`, …), mirroring the GHA Action contract. Also bundled into `actions/flare-dispatch-action/dist/index.js`. |
| `github-app create --endpoint <url>` | Live | Prints the manifest-creation URL for the App-installation flow. |
| `init` | **Planned (V4)** | Interactive setup; runs the wrangler/d1/kv create steps. |
| `deploy` | **Planned (V4)** | `wrangler deploy` + run migrations. |
| `executions list` | **Planned (V1)** | List recent executions (D1 query). |
| `executions view <id>` | **Planned (V1)** | Show execution details + log links. |
| `logs <execution-id> <step>` | **Planned (V1)** | Stream R2 NDJSON log. |
| `runs list` | **Planned (V4)** | List registered runs (`GET /health` returns the list today). |

The CLI uses `@effect/cli` and the same Effect-TS types as the run runtime — so options/args are typed, errors are tagged, and adding a subcommand is one file (`packages/cli/src/command.ts`). The standalone binary is `flare-dispatch`; from a monorepo checkout, invoke via `pnpm --filter @flare-dispatch/cli cli <subcommand>`.

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

> **Status: Planned (V4).** Neither `infra/r2-lifecycle.json` nor `infra/cron-cleanup.ts` ships at HEAD. The lifecycle policy and the D1 retention sweep are forward-looking; today an operator manages retention manually (drop and recreate the R2 bucket, or run an ad-hoc `wrangler d1 execute --command "DELETE FROM executions WHERE ..."`).

R2 lifecycle policy (to live in `infra/r2-lifecycle.json` once V4 lands):

```json
{
  "rules": [
    { "prefix": "cache/", "expiration": { "days": 30 } },
    { "prefix": "artifacts/", "expiration": { "days": 90 } },
    { "prefix": "logs/", "expiration": { "days": 14 } }
  ]
}
```

When V4 lands, this is applied with `wrangler r2 bucket lifecycle set flare-dispatch-prod --file infra/r2-lifecycle.json` (replaces the full policy). Individual rules can be appended with `wrangler r2 bucket lifecycle add flare-dispatch-prod ...` and removed with `wrangler r2 bucket lifecycle remove flare-dispatch-prod --id <rule-id>`. There is no `wrangler r2 bucket lifecycle put` subcommand.

*Source:* https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (2026-05).

D1 has no built-in lifecycle. The V4 plan is for the Dispatcher's `scheduled()` handler to prune `executions` and `steps` older than 90 days on a dedicated `0 3 * * *` tick — the same single `scheduled()` handler that today only routes cron ticks to Schedule-mode runs would gain a housekeeping branch. Until then, the Worker-wide `triggers.crons` array (see [§ Wrangler config](#wrangler-config)) carries only the Schedule-mode entries each run declares:

```jsonc
"triggers": { "crons": ["0 14 * * *"] }
```

## Cost ceiling — what to expect

For a small team (200 PRs/month, ~8 min average run wall time, 4-shard matrices), expect **~$8–15/month**; at 10× volume, **~$50–100/month**. Container compute is the dominant variable cost; everything else tends to stay within the included Workers Paid quotas.

The full pricing model, per-execution cost anatomy, both worked estimates, the head-to-head with GHA list pricing, and the cost levers are in [06-cost](06-cost.md).

## Security posture

A standalone trust/threat-model spec — adversaries, controls, and known gaps — is in [07-trust-model](07-trust-model.md). This section is the operator-facing summary.

- **HMAC** on `/v1/dispatch/:run` (live). 32-byte secret, raw-request-bytes canonicalization (`apps/dispatcher/src/hmac.ts`), constant-time `crypto.subtle.verify("HMAC", ...)`. No `timingSafeEqual` — that's Node-only and isn't on Workers. A 401 carries `dispatcher_secret_fingerprint = sha256(secret)[:8]` so an operator can diff it against the caller-side fingerprint (issue #24).
- **App webhook signature** on `/v1/webhooks/github`. `X-Hub-Signature-256` verified against `GITHUB_WEBHOOK_SECRET` with the same `crypto.subtle.verify` primitive. No shared secret with the user's GHA workflows. **Status: Planned (V1)** — receiver not yet wired.
- **Cloudflare Access** on `/v1/admin/*`. Worker re-verifies the Access JWT in code so a misconfigured Access app cannot leak the admin surface. The same `/v1/admin/events/:wf_id` route debounces `(wf_id, decider_email)` in `IDEMPOTENCY_KV` (1h window) so racing approvals are deterministic. **Status: Planned (V2/V3)** — lands with `step.waitForEvent`.
- **App installation tokens** are short-lived (1 hour TTL), scoped to one installation, refreshed on demand. At V0 cached in **Worker memory only**; KV-backed `INSTALL_TOKEN_KV` (55min TTL across Worker recycles) is Planned (V1). No long-lived PATs.
- **HTTP scheme allowlist** on the GHA Action's `endpoint` input (live). `packages/cli/src/dispatch.ts` rejects anything but `http:`/`https:` before any network attempt, blocking `file://` / `data:` / `ftp://` / cloud-metadata pivots.
- **`::error::` workflow-command escaping** (live). The Action's `safeForCmd` in `packages/cli/src/dispatch.ts` percent-encodes `%`/`\r`/`\n` and caps user-controlled strings at 500 chars before they reach a runner log, so a hostile Dispatcher response cannot inject a second workflow command.
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

A `infra/grafana/` dashboard is **Planned (V4)** once OTel export is wired.

## Reference: ship-ready checklist

- [ ] Workers Paid plan active
- [ ] `wrangler.jsonc` updated with bucket / db / KV IDs (live today: one KV `CONFIG_KV`; Planned V1 adds `IDEMPOTENCY_KV` + `INSTALL_TOKEN_KV`)
- [ ] D1 schema applied
- [ ] R2 lifecycle policy applied **(Planned, V4)**
- [ ] Worker Secrets set (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` always; `HMAC_SECRET` if using the GHA Action / direct-POST path; `BROWSER_CDP_CONNECT_URL` + `BROWSER_CDP_API_TOKEN` if running `cdp-acceptance`)
- [ ] GitHub App created and installed on target repos
- [ ] Cloudflare Access app configured for `/v1/admin/*` **(Planned, V2/V3 — only relevant once a run uses `step.waitForEvent`)**
- [ ] `health` endpoint returns ok with run list
- [ ] One successful dispatch end-to-end (CLI or GHA Action; App-webhook path lands in V1)
- [ ] Check-run appears on the PR
- [ ] Required-status-check configured on the protected branch
- [ ] `triggers.crons` lists every expression a run's `schedules` declares (plus `0 3 * * *` for the D1 retention sweep once V4 lands)
- [ ] Schedule-mode runs verified — `controller.cron` routes to the expected run(s); a cron tick produces a scheduling Workflow (check D1 `executions`)
