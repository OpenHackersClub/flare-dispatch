# 06 — V0 Walking-Skeleton Plan

The smallest end-to-end slice that proves the model from [00-overview](00-overview.md) § Roadmap:

> **V0 acceptance:** a `pnpm test` running in CF Sandbox reports green/red to a PR check.

Everything else from V1–V4 is deferred. This plan covers what we build, in what order, and how we know it works.

## 1. Scope

- **Dispatcher Worker** — HMAC verify on `POST /v1/dispatch/offload-test`, instantiate the Workflow, return `202 {runId}`. Plus `GET /health` and a single artifact endpoint `GET /v1/artifacts/:run/:name` that 302-redirects to a short-lived R2 signed URL.
- **One Workflow class** — `RecipeWorkflow extends WorkflowEntrypoint`, dispatches to `offload-test.run` under an Effect runtime.
- **One recipe** — `offload-test` (clone → exec → upload log → finalize). Inputs/outputs per [02-recipes § 1](02-recipes.md#1-offload-test).
- **Sandbox / Container binding** — single container per run, default Node image.
- **R2 bucket** — `logs/<run-id>/<step>.ndjson` only (no `cache/`, no `artifacts/` directory tar pipeline).
- **D1** — `runs` + `steps` tables per [01-architecture § Storage](01-architecture.md#storage).
- **GitHub App** — JWT → installation token → `POST /repos/.../check-runs` (in_progress) and `PATCH .../check-runs/{id}` (completed).
- **Effect-TS DSL surface** — `defineRecipe`, `step`, `sandbox.git.clone`, `sandbox.exec`, `artifact.upload` (logs only), `io.now`, `io.uuid`, `io.log`. Tagged errors from [03-dsl § Errors](03-dsl.md#errors). All other DSL surface stubbed to `Effect.die("not implemented in V0")`.
- **GHA composite Action** — `action.yml` + a ~50 LOC bash/node entry that HMAC-signs the body and POSTs. Fire-and-forget only.

## 2. Out of scope (deferred to V1+)

| Deferred | Why |
|---|---|
| Matrix fan-out (Queues + Coordinator DO + child Workflows) | Adds three components (Queue, DO, spawner) and the per-shard check-run aggregation. None of it is needed to prove a single container reports green/red. → V1. |
| Browser Rendering binding, `playwright-e2e`, `cdp-acceptance` | Requires browser pool + CDP plumbing + report merging. Orthogonal to "Sandbox → check-run." → V2. |
| Cache restore/save (`cache.restoreOr`, `cache.save`) | Optimization, not a correctness primitive. V0 reruns `pnpm install` every run; that's fine for a smoke. → V1. |
| Other recipes (`matrix-fanout`, `security-scan`, `custom-sandbox`) | One recipe is enough to prove the contract; the others are variations on the same DSL. → V1/V3. |
| CLI (`cf-recipes init`, `cf-recipes dispatch`, etc.) | A `curl` script and `wrangler deploy` cover V0 onboarding. → V4. |
| OpenTelemetry export | Workflows' built-in metrics + R2 NDJSON logs are enough to debug V0. → V4. |
| Multi-environment (`env.staging` / `env.prod`) | Single deploy on `*.workers.dev`. Splitting environments is mechanical once V0 works. → V4. |
| Retention crons (R2 lifecycle, D1 prune) | At V0 volumes, retention is "delete the bucket if you want a reset." → V4. |
| Custom domain | `https://cf-recipes-v0.<account>.workers.dev` is the public endpoint. Custom domain is DNS, not code. → V4. |
| `await` mode in the GHA Action | Fire-and-forget covers the acceptance criterion. Await mode adds polling + GHA timeout logic. → V1. |
| GitHub webhook re-run endpoint (`POST /v1/github/webhook`) | "Re-run failed checks" is a UX nicety, not required to prove green/red posting. → V1. |
| Container image build & publish to GHCR | V0 references `node:lts-slim` or a hand-built local image; the OHC base images are a separate stream. → V1. |

## 3. Repository layout for V0

```
cf-recipes/
├── wrangler.jsonc                              # bindings: Workflow, Container, R2, D1; no DO/Queue/Browser in V0
├── package.json                                # pnpm workspace root
├── pnpm-workspace.yaml                         # packages/* + apps/dispatcher
├── tsconfig.base.json                          # strict TS + Effect-friendly settings
├── .github/
│   └── workflows/
│       └── ci.yml                              # typecheck + vitest on every PR
├── apps/
│   └── dispatcher/
│       ├── package.json                        # depends on @cf-recipes/core + @cf-recipes/runtime-cf
│       ├── src/
│       │   ├── index.ts                        # Worker entry: fetch handler dispatching to routes
│       │   ├── routes/
│       │   │   ├── dispatch.ts                 # POST /v1/dispatch/:recipe — HMAC verify + instantiate Workflow
│       │   │   ├── artifacts.ts                # GET /v1/artifacts/:run/:name — sign + 302 redirect to R2
│       │   │   └── health.ts                   # GET /health — returns {status, recipes}
│       │   ├── hmac.ts                         # constant-time HMAC-SHA256 verify
│       │   ├── workflow.ts                     # RecipeWorkflow class extending WorkflowEntrypoint
│       │   └── env.ts                          # typed Env interface for bindings
│       └── tsconfig.json
├── packages/
│   ├── core/                                   # @cf-recipes/core — DSL primitives
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts                        # public exports
│   │   │   ├── define-recipe.ts                # defineRecipe constructor + Recipe<I,O> type
│   │   │   ├── step.ts                         # step() — wraps an Effect in a Workflow checkpoint
│   │   │   ├── errors.ts                       # Schema.TaggedError classes from 03-dsl § Errors
│   │   │   ├── context.ts                      # RecipeContext = Context.Tag union of services
│   │   │   ├── services/
│   │   │   │   ├── sandbox.ts                  # Context.Tag for SandboxService + interface
│   │   │   │   ├── artifact.ts                 # Context.Tag for ArtifactService + interface
│   │   │   │   ├── io.ts                       # Context.Tag for IOService + interface
│   │   │   │   ├── checks.ts                   # Context.Tag for ChecksService (GitHub check-runs)
│   │   │   │   └── runs.ts                     # Context.Tag for RunsService (D1 metadata writes)
│   │   │   └── fakes/                          # in-memory Layers for unit tests
│   │   │       ├── sandbox-fake.ts             # records exec calls; returns canned ExecResult
│   │   │       ├── artifact-fake.ts            # in-memory map of name → fake signed URL
│   │   │       ├── io-fake.ts                  # deterministic now/uuid for tests
│   │   │       ├── checks-fake.ts              # records check-run create/update calls
│   │   │       └── runs-fake.ts                # in-memory runs + steps tables
│   │   └── tsconfig.json
│   ├── runtime-cf/                             # @cf-recipes/runtime-cf — live CF bindings
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts                        # exports CFRuntimeLive Layer
│   │   │   ├── sandbox-cf.ts                   # SandboxService via Containers binding
│   │   │   ├── artifact-r2.ts                  # ArtifactService backed by R2 bucket
│   │   │   ├── io-live.ts                      # IOService using globalThis.crypto + Date
│   │   │   ├── runs-d1.ts                      # RunsService via D1 binding (INSERT runs/steps)
│   │   │   └── checks-github.ts                # ChecksService via GitHub App installation token
│   │   └── tsconfig.json
│   └── github-app/                             # @cf-recipes/github-app — App auth helpers
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── jwt.ts                          # sign App JWT with RS256 from PEM secret
│       │   ├── installation-token.ts           # exchange JWT for installation token; cache in-memory
│       │   └── check-runs.ts                   # POST/PATCH /repos/{owner}/{repo}/check-runs
│       └── tsconfig.json
├── recipes/
│   └── offload-test.ts                         # the V0 recipe (see 03-dsl § Top-level shape)
├── infra/
│   └── d1-schema.sql                           # runs + steps tables verbatim from 01-architecture § Storage
├── actions/
│   └── cf-recipes-action/
│       ├── action.yml                          # composite Action: 'using: composite', steps run dispatch.sh
│       ├── dispatch.sh                         # ~30 LOC: compute HMAC, curl POST, exit 0
│       └── README.md                           # usage snippet
├── README.md                                   # quickstart: wrangler deploy + Action snippet
└── specs/                                      # this directory (unchanged in V0)
```

## 4. PR sequence

Each PR targets `main`, is independently mergeable, and ships a single concern. The order makes downstream PRs reviewable in isolation (the prior PR's surface is already merged).

### PR 1 — Repo scaffold + wrangler config

- **What:** pnpm workspace, `tsconfig.base.json`, `wrangler.jsonc` declaring V0 bindings only (Workflow, Container, R2, D1 — no Queue/DO/Browser), `infra/d1-schema.sql`, empty `apps/dispatcher/src/index.ts` returning `{status: "ok"}` on `/health`, CI workflow running `pnpm typecheck` + `pnpm test`.
- **Verifiable acceptance:** `pnpm install && pnpm typecheck && wrangler deploy --dry-run` exits 0; `wrangler d1 execute cf-recipes-v0 --file infra/d1-schema.sql --local` creates both tables.

### PR 2 — `@cf-recipes/core` DSL + tagged errors + fakes

- **What:** `defineRecipe`, `step`, all `Schema.TaggedError` classes from [03-dsl § Errors](03-dsl.md#errors), `Context.Tag`s for `SandboxService`/`ArtifactService`/`IOService`/`ChecksService`/`RunsService`, and the in-memory fake Layer for each. No live implementations.
- **Verifiable acceptance:** `pnpm --filter @cf-recipes/core test` passes. A unit test composes `step("a", () => Effect.succeed(1))` and asserts the recipe runtime invokes the fake `RunsService` once per step. `Match.exhaustive` on every tagged error compiles.

### PR 3 — `offload-test` recipe + recipe-level unit tests

- **What:** `recipes/offload-test.ts` exactly as sketched in [03-dsl § Top-level shape](03-dsl.md#top-level-shape). Uses only `sandbox.git.clone`, `sandbox.exec`, `artifact.upload`, `io.now`. Unit tests under `recipes/offload-test.test.ts` using `CFRuntimeTest` + a `sandboxFakeProgram` matching the [03-dsl § Unit-testing recipes](03-dsl.md#unit-testing-recipes) pattern.
- **Verifiable acceptance:** `pnpm test` passes for: (a) green path — fake `pnpm test` exits 0, output `.exitCode === 0`; (b) red path — fake exits 1, output `.exitCode === 1`, no thrown error; (c) timeout — fake raises `ExecTimeout`, recipe re-fails with the same tag.

### PR 4 — Live runtime Layers (`@cf-recipes/runtime-cf`) + `RecipeWorkflow` class

- **What:** `SandboxCloudflareLive` calling the Containers binding, `R2ArtifactLive` writing log NDJSON, `D1RunsLive` writing `runs`/`steps` rows, `IOLive` using platform `crypto.randomUUID()`/`Date.now()`. `apps/dispatcher/src/workflow.ts` exports `RecipeWorkflow extends WorkflowEntrypoint`, whose `run(event, step)` maps each `step.do(name, ...)` call to a recipe `step(name, ...)` boundary. `wrangler.jsonc` workflows binding added.
- **Verifiable acceptance:** `pnpm dev` (wrangler dev) + `curl -X POST http://localhost:8787/v1/dispatch/offload-test -H 'X-CF-Recipes-Signature: sha256=<hmac>' -d @fixtures/dispatch.json` returns `202 {runId}`, and `wrangler d1 execute --local` shows one row in `runs` and N rows in `steps`. R2 `logs/<runId>/exec.ndjson` exists in local Miniflare R2.

### PR 5 — Dispatcher routes + HMAC verify + artifact signed-URL endpoint

- **What:** `apps/dispatcher/src/routes/dispatch.ts` does Schema-validate the body against `offload-test.inputs`, HMAC-verify with constant-time compare against `env.HMAC_SECRET`, then call `env.RECIPES_WORKFLOW.create({...})`. Add `GET /v1/artifacts/:run/:name` that signs an R2 URL and 302-redirects. `GET /health` lists registered recipes.
- **Verifiable acceptance:** `vitest run apps/dispatcher` covers: invalid HMAC → 401; valid HMAC + invalid body → 400 with Schema error inlined; valid HMAC + valid body → 202 + `{runId}`. A separate test fetches `/v1/artifacts/<runId>/exec.log` after a fake run and asserts 302 with a signed URL pointing at R2.

### PR 6 — GitHub App auth (`@cf-recipes/github-app`) + ChecksService live binding

- **What:** RS256 JWT signer using the PEM secret, installation-token exchange + in-memory cache (Worker memory + KV fallback per [04-gha-integration § Check-runs flow](04-gha-integration.md#check-runs-flow)), `POST` / `PATCH` to `/repos/{owner}/{repo}/check-runs`. Wire `ChecksGithubLive` into the runtime Layer so `offload-test` posts `in_progress` on start and `completed` with conclusion at end.
- **Verifiable acceptance:** Integration test against an MSW-mocked `api.github.com` asserts: (a) one POST to `/repos/.../check-runs` with `status: in_progress`; (b) one PATCH with `status: completed` and `conclusion: success` for green, `failure` for red. End-to-end manual: dispatch against a real test repo, observe check-run appears on the commit's Checks tab.

### PR 7 — GHA composite Action + acceptance smoke

- **What:** `actions/cf-recipes-action/action.yml` (composite, `using: composite`) calling `dispatch.sh`. `dispatch.sh` is ~30 LOC: compute `HMAC = openssl dgst -sha256 -hmac "$INPUT_HMAC_SECRET"`, curl POST, exit 0 on 202, fail on anything else. Plus a `.github/workflows/acceptance.yml` in this repo that uses the local action against the live deploy. Quickstart `README.md` with copy-paste deploy steps.
- **Verifiable acceptance:** A PR against this repo triggers `.github/workflows/acceptance.yml`, which calls the Action, which dispatches `offload-test` with `command: "pnpm test"` against this repo's own SHA. The check-run posted by the Worker turns green and appears as a required-status candidate on the PR. End-to-end timing recorded in PR comment.

## 5. Acceptance test

The full V0 walking skeleton works iff this sequence runs green from a fresh clone.

```sh
# 0. Prereqs — Cloudflare Workers Paid, gh CLI authed, wrangler ≥ 4
git clone https://github.com/openhackersclub/cf-recipes && cd cf-recipes
pnpm install
pnpm typecheck                       # PR1 + PR2 + PR3 + PR4 invariants
pnpm test                            # all unit tests across packages
```

```sh
# 1. Provision CF resources
wrangler r2 bucket create cf-recipes-v0
wrangler d1 create cf-recipes-v0
wrangler d1 execute cf-recipes-v0 --remote --file infra/d1-schema.sql
# wrangler writes IDs back into wrangler.jsonc

# 2. Set secrets
wrangler secret put HMAC_SECRET                          # 32-byte base64
wrangler secret put GITHUB_APP_ID                        # numeric
wrangler secret put GITHUB_APP_PRIVATE_KEY < ./app.pem   # piped from PEM
wrangler secret put GITHUB_WEBHOOK_SECRET                # not used in V0 but present

# 3. Deploy
wrangler deploy
# Note the deployed URL, e.g. https://cf-recipes-v0.<account>.workers.dev

# 4. Health check
curl -fsS https://cf-recipes-v0.<account>.workers.dev/health
# Expected: {"status":"ok","recipes":["offload-test"]}
```

```sh
# 5. Install the GitHub App on a test repo
# (manual: visit the app install URL from infra/github-app-manifest.json setup)

# 6. Direct dispatch — simulates what the GHA Action does
BODY='{"recipe":"offload-test","github":{"repo":"owner/test-repo","ref":"refs/heads/main","sha":"<sha>","installation_id":<id>},"inputs":{"repo":"owner/test-repo","sha":"<sha>","command":"pnpm test"},"trigger":{}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -binary | xxd -p -c 256)
curl -fsS -X POST https://cf-recipes-v0.<account>.workers.dev/v1/dispatch/offload-test \
  -H "Content-Type: application/json" \
  -H "X-CF-Recipes-Signature: sha256=$SIG" \
  -d "$BODY"
# Expected: 202 {"runId":"01J...","checkRunId":1234567}
```

```sh
# 7. Observe — within the recipe's wall-time ceiling
gh pr checks <pr-number-of-test-commit>
# Expected: cf-recipes/offload-test  PASS (or FAIL with the test command's exit)

# 8. Inspect via D1
wrangler d1 execute cf-recipes-v0 --remote --command "SELECT id, status, completed_at FROM runs WHERE id = '01J...'"
# Expected: status = success | failure, completed_at populated

# 9. Inspect log
wrangler d1 execute cf-recipes-v0 --remote --command "SELECT log_uri FROM steps WHERE run_id = '01J...' AND name = 'exec'"
# Open the returned log_uri (signed via /v1/artifacts/...); see NDJSON of exec output
```

```sh
# 10. PR-driven smoke (the real acceptance bar)
# In a downstream repo:
#   .github/workflows/ci.yml:
#     - uses: openhackersclub/cf-recipes-action@v0
#       with:
#         recipe: offload-test
#         endpoint: ${{ vars.CF_RECIPES_ENDPOINT }}
#         hmac-secret: ${{ secrets.CF_RECIPES_HMAC }}
#         inputs: '{"repo":"${{ github.repository }}","sha":"${{ github.sha }}","command":"pnpm test"}'
gh pr create --title "smoke: cf-recipes v0" --body "Tests the V0 walking skeleton"
gh pr checks <pr>
# Expected: cf-recipes/offload-test reports green when `pnpm test` passes, red when it fails.
```

If steps 4, 6, 7, and 10 all pass, V0 is complete and the [00-overview](00-overview.md) § Roadmap exit criterion is met.

## 6. Risks + open questions

- **Container image is upstream of V0.** The recipe assumes a working Node container image. The OHC base images (`cf-recipes-node:latest`) are a separate workstream; for V0 we either (a) hand-build a local image and reference it by digest, or (b) use `node:lts-slim` directly. PR1 should resolve which. *Risk:* slow first deploy if image isn't cached on CF's edge.
- **Sandbox / Containers binding API.** The spec assumes a `RECIPES_SANDBOX` binding with a `fetch`-like exec surface. The current Cloudflare Containers API has been evolving; PR4's `SandboxCloudflareLive` is the most likely spot to discover a mismatch between [01-architecture § Sandbox](01-architecture.md#data-plane) and reality. *Mitigation:* keep the `SandboxService` Tag interface narrow (`clone`, `exec`) so the live binding is a small surface to revise.
- **D1 write rate under load.** V0 writes one row per step transition (start + end). With only `offload-test` (4 steps), this is well within budget — but [01-architecture § Platform limits](01-architecture.md#platform-limits--design-constraints) flags D1 hot-path writes as a concern at V1+ matrix scale. Worth a row-count assertion in PR4's test.
- **Coordinator DO + Queue declared but unused.** [05-self-host § Wrangler config](05-self-host.md#wrangler-config) shows the Coordinator DO and `cf-recipes-fanout` Queue in `wrangler.jsonc`. For V0 we omit both — they're unused and a DO migration is irreversible. *Open question:* do we ship a stub `Coordinator` class in V0 to make the V1 migration a no-op, or land it cleanly in V1? Plan currently chooses the latter.
- **Artifact endpoint scope ambiguity.** [03-dsl § artifact](03-dsl.md#artifact) describes `artifact.upload` as a building block that returns a signed URL embedded in the check-run summary. For V0 we use it for logs only — but the dispatcher endpoint `GET /v1/artifacts/:run/:name` still needs to exist so the check-run summary's "view logs" link works. PR5 covers this; just noting the scope creep risk.
- **GitHub App per-installation token cache eviction.** [04-gha-integration § Check-runs flow](04-gha-integration.md#check-runs-flow) caches installation tokens in Worker memory with KV fallback. V0's PR6 ships memory-only — if the Worker is recycled mid-run, the next check-run write does a fresh JWT exchange. Acceptable for V0 throughput; flag for V1.
- **Recipe replay determinism.** [03-dsl § step Rules](03-dsl.md#step) requires non-determinism to flow through `io.now` / `io.uuid` so Workflow checkpoint replay is consistent. The `offload-test` recipe is simple enough that this is easy to enforce; PR3's unit test should explicitly assert no direct `Date.now()` / `crypto.randomUUID()` calls in the recipe body (lint or grep guard).
- **HMAC verification surface.** [04-gha-integration § Dispatch request body](04-gha-integration.md#dispatch-request-body) and [05-self-host § Secrets](05-self-host.md#secrets) both reference `HMAC_SECRET`, but neither pins the canonicalization of the signed body (raw bytes vs. JSON-normalized). PR5 must lock this down — recommend signing **raw request bytes** as received, no normalization — and document in `apps/dispatcher/src/hmac.ts`.
- **Workflow step duration vs. recipe wall-time.** `offload-test` declares `maxDurationSec` at the recipe level (per [02-recipes § 1](02-recipes.md#1-offload-test)), but a single `sandbox.exec` step is also bounded by the Workflow step duration ceiling. For V0 the recipe wall-time is shorter than the step ceiling so this is moot, but [01-architecture § Long-running test handling](01-architecture.md#long-running-test-handling) introduces chunked/detached execution that V0 explicitly does **not** implement. *Open question:* should the recipe error tag for "command exceeded the Workflow step ceiling" be a distinct `StepDurationExceeded` or fold into `ExecTimeout`? Plan currently folds — flag for V1 revisit.
