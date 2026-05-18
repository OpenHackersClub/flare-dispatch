# Recipe: browser tests (Playwright e2e)

Offload a slow Playwright e2e suite from GitHub Actions to Cloudflare. The suite is sharded with Playwright's native `--shard` flag — one CF container per shard, all in parallel — each using the Cloudflare Browser Rendering pool for the page session.

## Files

- [`playwright-e2e.run.ts`](playwright-e2e.run.ts) — the typed Run: fan out N shards, run `playwright test --shard i/N` in a container per shard, upload a report per shard.
- [`ci.yml`](ci.yml) — the GitHub Actions workflow that dispatches the run (Action mode, fire-and-forget).

## How it works

On `pull_request`, `ci.yml` calls `openhackersclub/flaredispatch-action`, which HMAC-signs a dispatch to your Dispatcher. The `playwright-e2e` run executes on Cloudflare; the result comes back as the `flaredispatch/playwright-e2e` check-run. The GHA job itself finishes in ~10 s — it only fires the dispatch.

## Install

1. Deploy FlareDispatch and install the GitHub App — see [specs/05-byoc.md](../../specs/05-byoc.md).
2. Add `playwright-e2e.run.ts` to your repo's `runs/` directory.
3. Copy `ci.yml` into `.github/workflows/`; adjust `baseURL` and `shards`.
4. In branch protection, require the `flaredispatch/playwright-e2e` check-run.
