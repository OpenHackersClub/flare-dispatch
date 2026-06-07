# Reference: `signals/v1` collector adapters

Standalone, copy-paste-able collector scripts that turn a third-party
observability source into the `signals/v1` shape the
[`ci-triage-pr`](../ci-triage-pr/) run folds into its daily triage draft PR.

> **These are reference adapters, not runs.** Unlike the rest of `recipes/`,
> this directory holds **consumer-side scripts**, not FlareDispatch runs. They
> never execute on the Dispatcher and are **not** mirrored from `runs/` by
> [`scripts/sync-recipes.mjs`](../../scripts/sync-recipes.mjs) — that script
> only syncs the hand-listed run/recipe `PAIRS`, so this directory does not
> trip `sync-recipes --check`. They run in **your** CI, next to your own
> credentials.

## What `signals/v1` is

A **signal** is one normalized observability finding a *consumer* collected
from a system the Dispatcher's own read capabilities don't reach — an
APM/tracing SaaS, runtime exception logs, a health probe, an alert webhook.
The contract is the deliberate **narrow waist** of the triage pipeline:

- The Dispatcher stays **vendor-blind** — it never queries Datadog / SigNoz /
  HyperDX / anything. Vendor query logic, credentials, and severity semantics
  all live with the caller (these adapters).
- Any vendor is supported on day one by a consumer-side adapter that prints
  this shape and feeds it to a run's `signals` input.

Contract source of truth: [`packages/core/src/signals.ts`](../../packages/core/src/signals.ts)
(and **specs/02-runs.md § Signals**). One signal:

```jsonc
{
  "source": "datadog:monitor",        // ≤120 — vendor-or-surface[:scope]
  "title":  "p99 latency > 2s",       // ≤200 — short title naming the error
  "detail": "Monitor in Alert state…",// ≤2000 — enough for a model to triage
  "url":    "https://app…/monitors/1",// ≤1000 — optional deep link
  "count":  3                          // optional — occurrences over the window
}
```

Caps (clamped locally by every adapter so an oversized scan still decodes at
the dispatch gate): **≤50 signals**, `source` ≤120, `title` ≤200, `detail`
≤2000, `url` ≤1000 chars.

## The producer contract (what every collector MUST do)

1. **stdout is ONLY the JSON `Signal[]`.** All diagnostics go to **stderr**.
2. **Always exit 0** with a valid (possibly empty) array. Each source the
   collector scans degrades to empty **independently** — a partial outage
   still produces a dispatch with whatever was observable.
3. **Respect the caps.** Group + truncate (one signal per failure **cluster**,
   not per raw event) rather than relying on the gate to reject an oversized
   payload as a 400.
4. **Order by severity, worst first** — array order is the only ranking the
   contract carries.

Every script in this directory is written against these four rules; run each
with no env to see the empty-array degradation (`node datadog/collect-signals.mjs`
→ `[]`).

## Wiring a collector into a daily GHA workflow

A collector produces `Signal[]` on stdout; the
[`flare-dispatch-action`](../../actions/flare-dispatch-action/action.yml)
dispatches `ci-triage-pr` with those signals as input. There are two ways to
hand the signals to the action.

### Option A — `collect-command:` one-liner (recommended)

The action runs your collector for you, captures its stdout, and folds it into
`inputs.signals` before signing the dispatch. *(The `collect-command:` input is
being added on the same branch stack as this directory; until it lands, use
Option B.)*

```yaml
name: daily-ci-triage
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: openhackersclub/flare-dispatch-action@v1
        with:
          run: ci-triage-pr
          endpoint: ${{ secrets.FLARE_DISPATCH_ENDPOINT }}
          hmac-secret: ${{ secrets.FLARE_DISPATCH_HMAC }}
          collect-command: "node recipes/signals-collectors/datadog/collect-signals.mjs --since 24h"
        env:
          DD_API_KEY: ${{ secrets.DD_API_KEY }}
          DD_APP_KEY: ${{ secrets.DD_APP_KEY }}
```

### Option B — manual `$GITHUB_OUTPUT` → `inputs:` JSON (fallback)

Run the collector in its own step, stash its stdout in a step output, then pass
`{"signals": …}` through the action's existing `inputs:` field (a JSON object
validated against the run's Schema on the Worker side).

```yaml
      - id: signals
        run: |
          json="$(node recipes/signals-collectors/datadog/collect-signals.mjs --since 24h)"
          echo "json=$json" >> "$GITHUB_OUTPUT"
        env:
          DD_API_KEY: ${{ secrets.DD_API_KEY }}
          DD_APP_KEY: ${{ secrets.DD_APP_KEY }}
      - uses: openhackersclub/flare-dispatch-action@v1
        with:
          run: ci-triage-pr
          endpoint: ${{ secrets.FLARE_DISPATCH_ENDPOINT }}
          hmac-secret: ${{ secrets.FLARE_DISPATCH_HMAC }}
          inputs: '{"signals": ${{ steps.signals.outputs.json }} }'
```

Because the collector always exits 0 with a valid array (even `[]`), a vendor
outage never fails the workflow — a green observability day simply dispatches
with no signals, and `ci-triage-pr` treats that as part of its green-day check.

## The three reference adapters

| Adapter | What it queries | Env vars |
|---|---|---|
| [`datadog/`](datadog/collect-signals.mjs) | Events API v2 search (`status:error` events, clustered by aggregation key) **and** Monitors API v1 (`group_states=alert`). Two independent sources. | `DD_API_KEY` (req), `DD_APP_KEY` (req), `DD_SITE` (opt, default `datadoghq.com`) |
| [`signoz/`](signoz/collect-signals.mjs) | `GET /api/v1/rules` — one signal per **firing** alert rule (name + description). | `SIGNOZ_API_URL` (opt, default `http://localhost:3301`), `SIGNOZ_API_KEY` (opt) |
| [`hyperdx/`](hyperdx/collect-signals.mjs) | **Degenerate-but-honest:** HyperDX has no public event-search API, so this emits one deep `level:error` **search-LINK** signal (so the PR links the live search) plus, when `HYPERDX_API_KEY` is set, best-effort alert states from `api.hyperdx.io`. | `HYPERDX_APP_URL` (req to emit the link), `HYPERDX_ENV` (opt), `HYPERDX_API_KEY` (opt) |

All three accept `--since <dur>` (e.g. `24h`, `90m`, `7d`; default `24h`).

### Why HyperDX is the honest degenerate case

The other two adapters can *count* errors and report real occurrence counts.
HyperDX exposes no public event-search API, so an adapter that pretended to
count would be lying. Instead it emits a single **search-link** signal — the
triage model and the human reviewer get a one-click jump into the live
`level:error` search for the window — and only adds *real* signals for alert
states it can actually read (when an API key is present). When nothing is
configured (`HYPERDX_APP_URL` unset) it degrades to `[]` like the rest: there
is no workspace to link to.

## A note on the duplicated cap helpers (deliberate)

Each script duplicates the same ~20 lines of cap-clamping helpers (`clamp`,
`signal`, `emit`, the caps mirror) rather than importing a shared module. That
is an intentional tradeoff: **these adapters must stay copy-paste-able as a
single file** — you should be able to drop *one* `.mjs` into your repo (or even
inline it into a workflow step) with zero local imports and no build step. The
cost is that a cap change in [`packages/core/src/signals.ts`](../../packages/core/src/signals.ts)
must be re-mirrored into each file; the caps are version-pinned to `signals/v1`
and only move on a `v2` bump (a new schema, not an edit), so the drift surface
is bounded.
