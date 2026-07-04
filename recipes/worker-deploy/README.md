# Recipe: continuous deployment on default-branch push

Every push to the default branch builds the repo and runs its deploy command (typically `wrangler deploy`) in a Sandbox container, with credentials injected from the FlareDispatch config store — and posts a green/red `flare-dispatch/worker-deploy` check on the deployed commit. The CD counterpart of `offload-test`'s CI; pair it with [`deploy-smoke`](../deploy-smoke/) for post-deploy probing.

## Files

- [`worker-deploy.run.ts`](worker-deploy.run.ts) — the typed Run: resolve the per-repo command + secrets from the config store, checkout, exec, upload the log.
- [`baseline.yml`](baseline.yml) — the plain-GHA workflow this replaces, for comparison.

There is no workflow file — this is a **Webhook-mode** recipe.

## How it works — `check_suite` as the push signal

The FlareDispatch App does not subscribe to the `push` event, and doesn't need to: GitHub creates a check suite for the head commit of **every push** and delivers `check_suite.requested` to Apps with `checks: write` — an event already in the App's subscription set, carrying `head_branch` and `head_sha`. The run's trigger gates on `head_branch === repository.default_branch`, so feature-branch pushes (whose PRs `offload-test` / `pr-review` already cover) never reach it.

Because a webhook trigger fires for every installed repo and its `gate` cannot read config, **opt-in is per-repo in the config store**: a repo with no `worker-deploy.command:<owner/repo>` key no-ops green (`skippedReason: "not-configured"`). There is deliberately no dispatcher-wide command fallback.

## Install

1. Deploy FlareDispatch and install the GitHub App on the repo — see [specs/05-byoc.md](../../specs/05-byoc.md). Webhook mode must be on (`GITHUB_WEBHOOK_SECRET` set).
2. Configure the repo's deploy command and credentials in CONFIG_KV:

```sh
# The deploy command, run at the repo root of a fresh checkout of the pushed SHA.
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.command:owner/repo" \
  "pnpm install --frozen-lockfile && pnpm build && pnpm exec wrangler deploy"

# Env-var names to inject (comma-separated), and the config-store prefix
# their values live under.
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.secrets:owner/repo" "CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID"
wrangler kv key put --binding=CONFIG_KV \
  "worker-deploy.secret-prefix:owner/repo" "secret/"

# The credential values themselves. Scope the API token to just the target
# Worker (Workers Scripts:Edit + the zone's Workers Routes:Edit if the Worker
# claims a custom domain) — the container gets exactly what the deploy needs.
wrangler kv key put --binding=CONFIG_KV "secret/CLOUDFLARE_API_TOKEN" "<token>"
wrangler kv key put --binding=CONFIG_KV "secret/CLOUDFLARE_ACCOUNT_ID" "<account-id>"
```

3. Push to the default branch; the `flare-dispatch/worker-deploy` check appears on the commit. Require it in branch protection if merges must be deployable.

Changing the command or rotating a credential is a KV write — **no redeploy of the dispatcher**.

## Patterns worth embedding in the command

The command is a shell string executed in an authenticated checkout, so repo-specific guards belong there, not in run code:

- **Post-deploy verification** — assert the deployed surface responds the way you expect before the check goes green. E.g. a site that must sit behind an auth gate (an anonymous `200` would mean the gate is gone):

  ```sh
  … && pnpm exec wrangler deploy && \
  code=$(curl -s -o /dev/null -w '%{http_code}' https://app.example.com/) && \
  [ "$code" != "200" ] || { echo "auth gate missing — got anonymous 200"; exit 1; }
  ```

- **Stale-push guard** — two rapid pushes dispatch two executions keyed by SHA, and completion order isn't guaranteed. If last-writer-wins matters, skip when the checkout is no longer the branch head (the clone's `origin` is authenticated):

  ```sh
  [ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)" ] \
    || { echo "superseded by a newer push"; exit 0; }
  ```

- **Path filter** — a monorepo that only wants to deploy when a subtree changed can diff and bail:

  ```sh
  git diff --quiet HEAD~1 HEAD -- apps/site/ && { echo "no site changes"; exit 0; } || true
  ```

## Action mode

The same run is dispatchable per-call (`POST /v1/dispatch/worker-deploy`) with an explicit `command` / `secrets` / `secretPrefix` in the body — useful for a manual redeploy or interleaving with other GHA jobs. In Action mode `failOnNonZeroExit` defaults to `false` and the caller reads `exitCode`, mirroring `offload-test`.
