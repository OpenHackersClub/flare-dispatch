# Recipe: post-deploy smoke test

After a production deploy succeeds, hit the live URL and a few critical endpoints; fail a check-run on the deployed commit if anything is down.

## Files

- [`smoke.run.ts`](smoke.run.ts) — the typed Run: probe each path with `curl`, classify by HTTP status, report how many endpoints are healthy.

There is no workflow file — this is a **Webhook-mode** recipe.

## How it works

The run declares a `triggers` entry on the `deployment_status` event. When GitHub fires `deployment_status` with `state: success` for a production deploy, the `FlareDispatch` GitHub App webhook delivers it to the Dispatcher, which evaluates the trigger's `gate` and starts the run — no GHA workflow, zero GHA minutes.

The gate also requires a non-empty `environment_url` (the field is optional in GitHub's payload), and the idempotency key is the `deployment.id` — so a redeploy or rollback-forward of the same commit gets its own fresh smoke test rather than collapsing onto the first.

## Install

1. Deploy FlareDispatch and install the GitHub App — see [specs/05-byoc.md](../../specs/05-byoc.md). The App must subscribe to the `deployment_status` event (the manifest in 05-byoc does).
2. Add `smoke.run.ts` to your repo's `runs/` directory and push.
3. The Dispatcher auto-discovers the run; the next successful production deploy gets a `flaredispatch/deploy-smoke` check.
