# flare-dispatch-action

Node 20 JavaScript Action that dispatches a [FlareDispatch](../../README.md)
run. It HMAC-signs a dispatch body and POSTs it to your Dispatcher Worker; the
run executes asynchronously on Cloudflare and reports its result back to the
PR via a GitHub **check-run** — not via this step.

The runtime is a single bundled JS file at [`dist/index.js`](./dist/index.js),
produced from `@flare-dispatch/cli`
(`packages/cli/src/action-entry.ts`) via
`pnpm --filter @flare-dispatch/cli build`. The bundle is committed because
JS Actions are consumed by ref — the runner does NOT `npm install`. It
runs in seconds on a normal hosted runner — no `self-hosted`, no PAT.

## Usage

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

In branch protection, require the **check-run** name (e.g. `flare-dispatch/offload-test`),
not this GHA job — the check-run is the real PR signal. The step itself succeeds
the moment the dispatch is accepted (`202`).

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `run` | yes | — | Run slug. Must exist on the target Dispatcher deploy. |
| `endpoint` | yes | — | Dispatcher base URL, e.g. `https://flare-dispatch.<account>.workers.dev`. |
| `hmac-secret` | yes | — | Shared HMAC secret. Same value as the Worker's `HMAC_SECRET`. |
| `inputs` | no | `{}` | JSON object of run inputs. Validated against the run's Schema on the Worker side. |
| `mode` | no | `fire-and-forget` | **V0 supports `fire-and-forget` only.** Passing `await` fails the step — await mode is deferred to V1 (see [`specs/pm/plan.md` § 2](../../specs/pm/plan.md)). |
| `check-name` | no | `flare-dispatch/<run>` | Overrides the check-run name. |
| `installation-id` | no | `0` | GitHub App installation id for the target repo. Optional — a Dispatcher that has already seen this repo resolves it server-side from the App's webhook-registered installation map. |

## Outputs

| Output | Notes |
|---|---|
| `execution-id` | ULID of the execution on Cloudflare. Always set — the Dispatcher returns it in the `202`. |

## Failure handling

Per [`specs/04-gha-integration.md` § Failure handling](../../specs/04-gha-integration.md):

- **Dispatcher unreachable / `429` / `5xx`** — retried up to 3× with backoff, then the step fails.
- **`401`** (HMAC rejected) — config bug; the step fails immediately, no retry. The job log prints two 8-char fingerprints (`sha256(secret)[:8]`):

  ```
  HMAC drift between flare-dispatch-action and Dispatcher Worker.
    local secret fingerprint      = 1f3a9c2e
    dispatcher secret fingerprint = 1f3a9c2f
  ```

  Compare them — if they differ, re-sync the secret on the mismatching side (`gh secret set FLAREDISPATCH_HMAC` or `wrangler secret put HMAC_SECRET`). A trailing newline pasted into one side and not the other is the dominant cause. If they match, the canonicalization contract has drifted (file a bug).
- **`400`** (inputs fail the run Schema) / **`404`** (unknown run) — the step fails immediately with the Dispatcher's error inlined.
