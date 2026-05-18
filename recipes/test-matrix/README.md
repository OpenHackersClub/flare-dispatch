# Recipe: sharded test matrix

Run the same command across N shards in parallel — one CF container per shard. The parent check-run is green only if every shard passes. Each shard receives `SHARD_INDEX` / `SHARD_TOTAL` in its environment so the command can split its own work.

## Files

- [`matrix-fanout.run.ts`](matrix-fanout.run.ts) — the typed Run: fan out N shards, run the command in a container per shard, collect exit codes and per-shard logs.
- [`ci.yml`](ci.yml) — the GitHub Actions workflow that dispatches the run (Action mode, fire-and-forget).

## How it works

On `pull_request`, `ci.yml` dispatches `matrix-fanout` with a `command` and a `shards` count. The run executes every shard on Cloudflare and reports a single `flare-dispatch/matrix-fanout` check-run. A typical `command` is `pnpm test --shard $SHARD_INDEX/$SHARD_TOTAL`.

## Install

1. Deploy FlareDispatch and install the GitHub App — see [specs/05-byoc.md](../../specs/05-byoc.md).
2. Add `matrix-fanout.run.ts` to your repo's `runs/` directory.
3. Copy `ci.yml` into `.github/workflows/`; adjust `command` and `shards`.
4. In branch protection, require the `flare-dispatch/matrix-fanout` check-run.
