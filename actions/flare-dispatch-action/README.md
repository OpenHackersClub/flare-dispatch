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
| `collect-command` | no | `""` | Optional consumer-side observability collector — see [Collecting signals](#collecting-signals-collect-command) below. |
| `mode` | no | `fire-and-forget` | **V0 supports `fire-and-forget` only.** Passing `await` fails the step — await mode is deferred to V1 (see [`specs/pm/plan.md` § 2](../../specs/pm/plan.md)). |
| `installation-id` | no | `0` | GitHub App installation id for the target repo. Optional — a Dispatcher that has already seen this repo resolves it server-side from the App's webhook-registered installation map. |
| `notify-emails` | no | `""` | Optional recipients emailed the run's result on completion. Comma/whitespace separated or a JSON array. Each must be a verified Cloudflare Email Routing destination on the Dispatcher's zone. |

## Outputs

| Output | Notes |
|---|---|
| `execution-id` | ULID of the execution on Cloudflare. Always set — the Dispatcher returns it in the `202`. |
| `details-url` | Cloudflare Workflows instance URL for the execution (steps/logs). Empty under BYOC or on older Dispatchers. |

## Collecting signals (`collect-command`)

A run such as [`ci-triage-pr`](../../specs/02-runs.md#11-ci-triage-pr) can triage
**signals** — observability findings the Dispatcher's own read capabilities
can't reach (an APM/tracing SaaS, runtime exception logs, health probes). The
Dispatcher never queries those vendors; instead you point `collect-command` at a
**consumer-side collector** that prints the [`signals/v1`](../../specs/02-runs.md#signals)
shape, and the Action folds its output into the dispatch.

```yaml
- uses: openhackersclub/flare-dispatch-action@v0
  with:
    run: ci-triage-pr
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    # Your collector. Prints ONLY signals/v1 JSON to stdout, exits 0.
    collect-command: node scripts/collect-observability-errors.mjs
```

Contract for the command:

- **stdout is ONLY the JSON payload** — a bare `Signal[]` array, or an object
  with a `signals` array property. Diagnostics go to **stderr** (passed through
  to the runner log).
- **Exit 0** with a valid (possibly empty) array. A non-zero exit, or output
  that isn't valid `signals/v1`, **fails the Action before signing** — the
  collector is broken; better to surface that than dispatch silently.
- **Respect the caps**: ≤ 50 items; `source` ≤ 120, `title` ≤ 200, `detail` ≤
  2000, `url` ≤ 1000 chars; `source`/`title`/`detail` required. Cluster (one
  signal per failure cluster), don't enumerate raw events.

Collected signals are appended to any `signals` already in `inputs`
(caller-provided first), re-validated against the 50-item cap, and — because
`ci-triage-pr` requires it — a `firedAt` is defaulted to "now" when the merged
inputs carry signals but no `firedAt`. The full machine-readable contract is
[`schemas/signals.v1.schema.json`](../../schemas/signals.v1.schema.json).

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
- **`collect-command`** non-zero exit or invalid output — the step fails **before** any network call, with the collector's stderr tail (non-zero exit) or the validation reason (malformed `signals/v1` output) inlined. No dispatch is signed or sent.
