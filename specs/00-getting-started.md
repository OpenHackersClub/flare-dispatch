---
title: Getting Started
description: Deploy the FlareDispatch Dispatcher into your own Cloudflare account, install the GitHub App, and wire the GHA Action — under an hour, end to end.
---

# Getting Started

FlareDispatch offloads the expensive half of GitHub Actions onto a Cloudflare stack **you own** — Workflows orchestrate, Containers execute, Browser Rendering drives e2e, R2 holds cache and artifacts. You `wrangler deploy` one Worker (the **Dispatcher**) into your own Cloudflare account, install your **own** GitHub App, and point a GHA step at it. No multi-tenant SaaS; trust ends at your CF account.

This page is the fast path. The depth references are [BYOC Deployment](/docs/05-byoc) (every binding, secret, and the full App flow), [GHA Integration](/docs/04-gha-integration) (the three trigger modes), and the [README Quickstart](https://github.com/OpenHackersClub/flare-dispatch#quickstart).

> **What you end up with:** a GHA workflow calls the Action, which HMAC-signs a dispatch and POSTs your Dispatcher. The Dispatcher runs the job in a Container and reports the result back to the PR as a `flare-dispatch/<run>` **check-run**. The GHA step finishes in seconds — zero GitHub minutes are spent on the execution itself.

## Prerequisites

| | Required | Notes |
|---|---|---|
| Cloudflare account | **Workers Paid** ($5/mo) | Containers, Workflows, Browser Rendering, and the useful R2 quotas live on the Paid plan. The only hard money requirement. |
| `wrangler` CLI | ≥ 4 | `npm i -g wrangler` |
| `pnpm` | ≥ 9 | For the run repo itself |
| Node | ≥ 20 | For Wrangler |
| GitHub org/account admin | yes | To create and install your GitHub App |
| A custom CF domain | optional | `*.workers.dev` works fine for v0 |

There are two ways to do the setup below — an **Automatic** path (hand it to a coding agent) and a **Manual** path (run the steps yourself). Both end at the same [Verify](#verify) step.

---

## Automatic setup

Paste this prompt into a coding agent (Claude Code, Cursor, …) running in an empty directory. It reads the published docs index, then performs the deploy + wire for you:

```text
Set up FlareDispatch (BYOC CI offload on Cloudflare) for me.

1. Read https://flare-dispatch.openhackers.club/llms.txt and then
   https://flare-dispatch.openhackers.club/docs/00-getting-started to learn the
   exact deploy and wiring steps.
2. Clone https://github.com/openhackersclub/flare-dispatch, pnpm install, and
   run `pnpm typecheck && pnpm test` to confirm a clean checkout.
3. Provision the Cloudflare resources with wrangler (R2 bucket, D1 database,
   CONFIG_KV namespace), apply the D1 migrations, set the Worker secrets
   (HMAC_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY), and `wrangler deploy`.
   Stop and ask me before running any command that needs my Cloudflare login.
4. Print the deployed URL and the GitHub-App install URL
   (`pnpm --filter @flare-dispatch/cli cli github-app create --endpoint <url>`),
   and walk me through installing the App on my repo.
5. Wire the GHA Action into a repo I name: set the repo variable
   FLAREDISPATCH_ENDPOINT and the repo secret FLAREDISPATCH_HMAC, and add an
   `openhackersclub/flare-dispatch-action@v0` step running the `offload-test` run.
6. Verify by curling `<endpoint>/health` and confirming the 11 runs are listed.

Use the commands exactly as documented; do not invent bindings or secrets.
```

The agent does the same steps as the [Manual setup](#manual-setup) below — read those if you want to know what it is doing, or if anything needs a human decision (which GitHub org owns the App, which repos to install on).

---

## Manual setup

Three stages: **deploy the Dispatcher → install the GitHub App → wire the Action**.

### 1. Deploy the Dispatcher

```sh
git clone https://github.com/openhackersclub/flare-dispatch && cd flare-dispatch
pnpm install
pnpm typecheck && pnpm test

# Provision CF resources — wrangler writes the IDs back into wrangler.jsonc
wrangler r2 bucket create flare-dispatch-v0
wrangler d1 create flare-dispatch-v0
wrangler kv namespace create CONFIG_KV

# Apply the D1 schema (migrations live in infra/migrations/)
wrangler d1 migrations apply RUNS_METADATA --remote

# Set the Worker secrets
wrangler secret put HMAC_SECRET                          # openssl rand -base64 32
wrangler secret put GITHUB_APP_ID                        # numeric App id (set after step 2)
wrangler secret put GITHUB_APP_PRIVATE_KEY < ./app.pem   # piped from the PEM (set after step 2)

wrangler deploy
# Note the deployed URL, e.g. https://flare-dispatch-v0.<account>.workers.dev
```

The single Dispatcher Worker is bound to the live stack declared in `wrangler.jsonc`: `RUNS_WORKFLOW` (Workflow), `RUNS_SANDBOX` + `RUNS_SANDBOX_BROWSER` (Container DOs — lean and chromium-baked), `RUNS_STORAGE` (R2), `RUNS_METADATA` (D1), `CONFIG_KV` (KV), `AI` (Workers AI — the binding *is* the auth for `pr-review`, no model API key), and `BROWSER` (Browser Rendering). The full binding table, the optional bindings (`IDEMPOTENCY_KV`, `INSTALL_TOKEN_KV`), and the opt-in `send_email` block are in [BYOC Deployment § What you deploy](/docs/05-byoc).

The secrets:

| Secret | What | How to generate | Required for |
|---|---|---|---|
| `HMAC_SECRET` | Shared with the GHA Action / direct-POST callers; verifies inbound dispatches | `openssl rand -base64 32` | Action path + direct-POST path (skip if you use only the App-webhook trigger) |
| `GITHUB_APP_ID` | Numeric App id | From the App's settings page (step 2) | Always |
| `GITHUB_APP_PRIVATE_KEY` | PEM key for App auth | "Generate a private key" on the App page (step 2) | Always |
| `GITHUB_WEBHOOK_SECRET` | Verifies inbound App webhooks (`X-Hub-Signature-256`) | `openssl rand -base64 32` | **Webhook mode only** — opt-in; a deploy without it `503`s that route |

`GITHUB_APP_PRIVATE_KEY` is large — pipe it from a file, then delete the local PEM. The App id and private key come from step 2, so you will re-run those two `wrangler secret put` calls (and `wrangler deploy`) after creating the App.

### 2. Install the GitHub App

**The App is BYOC too — there is no shared central app.** You create your own FlareDispatch App under your account or org via the App-Manifest flow; its private key, webhook secret, and client secret stay in your own Worker Secrets. The repo ships only the manifest template (`infra/github-app-manifest.json`), never a Marketplace app.

1. Get the install URL — the CLI prints it for you:

   ```sh
   pnpm --filter @flare-dispatch/cli cli github-app create \
     --endpoint https://flare-dispatch-v0.<account>.workers.dev
   ```

   It points at `<your-endpoint>/v1/github/install/new`. Open that in a browser. The Dispatcher renders an **owner chooser** — pick **Personal account** or **Organization** (org-owned survives any one admin leaving; recommended for teams).
2. The chooser POSTs the manifest to GitHub; GitHub redirects back to `<your-endpoint>/v1/github/installed?code=<code>`, where the Dispatcher exchanges the code and renders a one-shot **Success** page surfacing the App's credentials and the exact `wrangler secret put` commands.
3. Stash `app_id`, `private_key` (and `webhook_secret`, `client_id`, `client_secret`) into Worker Secrets — they are shown **once**. Concretely, run the `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (and, for Webhook mode, `GITHUB_WEBHOOK_SECRET`) puts from step 1, then `wrangler deploy` again.
4. Click **Install** on the Success page (it links to `https://github.com/apps/<slug>/installations/new`) and pick your org or the specific repos.
5. At HEAD, pass each installation's `installation_id` to the Action (the `installation-id` input) or as a run input — or just let the Dispatcher resolve it server-side once it has seen the repo.

Full walkthrough, the manifest permissions, and the CSRF-state caveat are in [BYOC Deployment § GitHub App setup](/docs/05-byoc).

### 3. Wire the GHA Action into a repo

Set on the repo (org-level works too):

- **Variable** `FLAREDISPATCH_ENDPOINT` — the deployed Dispatcher URL.
- **Secret** `FLAREDISPATCH_HMAC` — the **same value** as the Worker's `HMAC_SECRET`.

Then add the Action to a workflow:

```yaml
# .github/workflows/ci.yml
- uses: openhackersclub/flare-dispatch-action@v0
  with:
    run: offload-test
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      { "repo": "${{ github.repository }}", "sha": "${{ github.sha }}", "command": "pnpm test" }
    mode: fire-and-forget
```

The Action HMAC-signs the dispatch and POSTs it; the run's result lands on the PR as the `flare-dispatch/offload-test` check-run. **Require that check-run in branch protection — not the GHA job.** The GHA step itself succeeds the moment dispatch is accepted (`202`).

Key Action inputs (full table in the [Action README](https://github.com/OpenHackersClub/flare-dispatch/blob/main/actions/flare-dispatch-action/README.md)):

| Input | Required | Default | Notes |
|---|---|---|---|
| `run` | yes | — | Run slug; must exist on the target deploy |
| `endpoint` | yes | — | Dispatcher base URL |
| `hmac-secret` | yes | — | Same value as the Worker's `HMAC_SECRET` |
| `inputs` | no | `{}` | JSON object, validated against the run's Schema on the Worker side |
| `mode` | no | `fire-and-forget` | **V0 supports `fire-and-forget` only**; `await` is Planned (V1) and fails the step today |
| `installation-id` | no | `0` | App installation id; optional once the Dispatcher has seen the repo |

> Other trigger modes need no `.github/workflows/` change at all: **Webhook mode** (the App fires the Dispatcher directly — opt-in, set `GITHUB_WEBHOOK_SECRET`) and **Schedule mode** (a Cloudflare Cron Trigger). See [GHA Integration](/docs/04-gha-integration).

---

## Verify

Confirm the Dispatcher is up and lists the registered runs:

```sh
curl -fsS https://flare-dispatch-v0.<account>.workers.dev/health
# {"status":"ok","runs":["cdp-acceptance","ci-triage-pr","deploy-smoke","matrix-fanout","offload-test","playwright-demo","playwright-e2e","pr-review","product-demo","refresh-fixtures","spec-drift-pr"]}
```

All **11** registered runs, sorted. If you see them, the Worker, its bindings, and the D1 migration all landed.

For a true end-to-end check before touching a real PR, dispatch from the CLI (it mirrors the Action contract):

```sh
INPUT_RUN=offload-test \
INPUT_ENDPOINT=https://flare-dispatch-v0.<account>.workers.dev \
INPUT_HMAC_SECRET=$HMAC_SECRET \
INPUT_INPUTS='{"repo":"owner/test-repo","sha":"<sha>","command":"echo hello"}' \
GITHUB_REPOSITORY=owner/test-repo GITHUB_SHA=<sha> \
  pnpm --filter @flare-dispatch/cli cli dispatch
```

The Dispatcher opens a check-run on the commit and reports `success` once `echo hello` completes in a container. A `401` here means HMAC drift — the job log prints two `sha256(secret)[:8]` fingerprints to compare (re-`put` the mismatching side; a stray trailing newline is the usual cause).

### Ship-ready checklist

- [ ] Workers Paid plan active
- [ ] `wrangler.jsonc` has the bucket / D1 / `CONFIG_KV` ids filled in by wrangler
- [ ] D1 migrations applied
- [ ] Worker secrets set (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`; `HMAC_SECRET` for the Action path)
- [ ] GitHub App created and installed on the target repos
- [ ] `/health` returns ok with the 11-run list
- [ ] One successful dispatch end-to-end (CLI or Action)
- [ ] Check-run appears on the PR, and is the **required** status check on the protected branch

Next: browse the [Runs catalog](/docs/02-runs), the [recipes](/recipes), or harden the deploy via [Trust & Threat Model](/docs/07-trust-model).