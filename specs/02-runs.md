# 02 — Runs

Runs are the user-facing unit. Each run has a stable contract — name, input Schema, output Schema, declared limits, and the Cloudflare platform primitives it touches — so GHA workflows can call them without knowing the implementation. A run's body is composed from **DSL primitives** (`workspace`, `installCached`, `sharded`, …) — see [03-dsl § Primitives](03-dsl.md#primitives). The `cache-*` and `r2-artifacts` entries below are primitives, not runs: they are composed inside other runs via the DSL and aren't directly dispatch-able.

> Two senses of "primitive" appear here. **Platform primitives** are the Cloudflare building blocks a run runs on — Sandbox, Workflows, R2, D1, Browser Rendering; each run lists the ones it uses under **Platform:**. **DSL primitives** are the reusable Effect-TS compositions a run is *written with* — [03-dsl § Primitives](03-dsl.md#primitives).

## Run contract

Every shipped run exports:

```ts
{
  name: string;                              // unique slug
  version: string;                           // semver
  inputs: Schema.Schema<I, IEncoded>;        // typed input contract
  outputs: Schema.Schema<O, OEncoded>;       // typed output contract
  image?: string;                            // documentary registry-image URI (not yet a runtime pull)
  sandboxImage?: "lean" | "browser";         // which deploy-bound container image to route to (default "lean")
  limits: {
    maxDurationSec: number;                  // wall-time ceiling
    maxConcurrency?: number;                 // shards or parallel executions
    requiresBrowser?: boolean;               // reserve a CF Browser Rendering slot
  };
  triggers?: TriggerSpec<I>[];                // Webhook-mode trigger config
  schedules?: ScheduleSpec<I>[];              // Schedule-mode trigger config (cron)
  writeback?: WritebackSpec;                  // "propose a diff as a PR" — see § Writeback
  run: (input: I) => Effect.Effect<O, RunError, RunContext>;
}
```

A user-defined run in their own repo has the same shape. The shipped runs below are the starter library. `triggers` / `schedules` are both optional and select the run's trigger mode — see [03-dsl § `defineRun`](03-dsl.md#definerun).

### `sandboxImage` — which container image to boot

`sandboxImage` selects which of the deploy's already-bound Container images a run routes to — the dispatcher maps it to `RUNS_SANDBOX` vs `RUNS_SANDBOX_BROWSER` (see [`apps/dispatcher/src/workflow.ts`](../apps/dispatcher/src/workflow.ts), [`packages/core/src/define-run.ts`](../packages/core/src/define-run.ts)):

- `"lean"` (**default**) — the base sandbox image. Correct for the majority of runs **and** for every `limits.requiresBrowser: true` run: those dial CF Browser Rendering over CDP (they connect *out* to a CF-managed browser), so they need no chromium baked in.
- `"browser"` — the image with `chromium-headless-shell` baked in, for a run that launches Playwright's *own* chromium *inside* the sandbox and drops the `playwright install` step to rely on the baked browser. The value is wired and available; no shipped run currently selects it (`playwright-demo` runs chromium in-sandbox but its caller installs it, so it stays `"lean"`).

This axis is deliberately **distinct** from `limits.requiresBrowser`: `requiresBrowser` = "reserve a CF Browser Rendering slot"; `sandboxImage` = "which container image to boot". A run can be `requiresBrowser: true, sandboxImage: "lean"` (CDP, no in-image browser) or `requiresBrowser: false, sandboxImage: "browser"` (in-sandbox Playwright). (Don't confuse `sandboxImage` with the documentary `image` field, which names a specific registry artifact and does **not** yet drive a runtime image-pull — Container images are bound to DO classes at deploy.)

---

## Catalog

| | Run | When to use | Status |
|---|---|---|---|
| 1 | [`offload-test`](#1-offload-test) | Single command, single container, pass/fail back to GHA | **Live at HEAD** (V0) |
| 2 | [`matrix-fanout`](#2-matrix-fanout) | Same command across N shards in parallel | **Live at HEAD** (V1) — runs inline `sharded` |
| 3 | [`playwright-e2e`](#3-playwright-e2e) | Sharded Playwright tests with browser pool | **Live at HEAD** (V2) |
| 4 | [`cdp-acceptance`](#4-cdp-acceptance) | Boot an app + assert via CDP observations | **Live at HEAD** (V2) |
| 5 | [`product-demo`](#5-product-demo) | AI-driven product demo over CDP, Action + Schedule mode; on completion, GIF + summary PR comment | **Live at HEAD** (V3) |
| 6 | [`deploy-smoke`](../runs/deploy-smoke.ts) | Post-deploy smoke test against a live URL, Webhook-mode-first | **Live at HEAD** (V2) |
| 7 | [`playwright-demo`](../runs/playwright-demo.ts) | Record a Playwright walkthrough of a deployed surface | **Live at HEAD** (V3) |
| 8 | [`security-scan`](#6-security-scan) | `npm audit` / `cargo audit` / `trivy` / `grype` | Planned (V3) |
| 9 | [`custom-sandbox`](#7-custom-sandbox) | Escape hatch — run any bash in a container | Planned (V3) |
| 10 | [`spec-drift-pr`](#10-spec-drift-pr) | Daily spec/implementation drift → draft PR with the reconciling spec edits | **Live at HEAD** (V3) — Schedule mode |
| 11 | [`ci-triage-pr`](#11-ci-triage-pr) | Daily triage of GitHub Actions + Cloudflare deploy failures → draft PR | **Live at HEAD** (V3) — Schedule mode |
| 12 | [`pr-review`](#12-pr-review) | AI code review on every PR push — single- or multi-agent, backend selectable from `CONFIG_KV` (incl. Bedrock via the BYOC OIDC→STS trust path) | **Live at HEAD** (V3) — Webhook mode |
| 13 | [`refresh-fixtures`](#13-refresh-fixtures) | Regenerate tracked files in a credential-free container → propose a PR (writeback) | **Live at HEAD** (V3) — worked `writeback` example |
| — | [`cache-*`](#primitive-cache-pnpm--npm--cargo--uv) | Primitive — R2-backed package cache (`installCached`) | **Live at HEAD** — capability + primitive |
| — | [`r2-artifacts`](#primitive-r2-artifacts) | Primitive — artifact upload + signed URLs (`artifact`) | **Live at HEAD** — capability wired |
| — | [`awsAssumeRole`](03-dsl.md#awsassumerole) | Primitive — OIDC-federated AWS STS credentials | **Live at HEAD** — capability + primitive |

> **Live runs at HEAD** — all eleven registered runs (`offload-test`, `cdp-acceptance`, `deploy-smoke`, `matrix-fanout`, `playwright-e2e`, `product-demo`, `playwright-demo`, `pr-review`, `spec-drift-pr`, `ci-triage-pr`, `refresh-fixtures`) ship from [`runs/index.ts`](../runs/index.ts) + the dispatcher's `RUN_REGISTRY` ([`apps/dispatcher/src/registry.ts`](../apps/dispatcher/src/registry.ts)); `/health` lists them sorted. All three trigger modes are wired: **Action mode** (HMAC `POST /v1/dispatch/:run`), **Schedule mode** (Cron Trigger → `scheduled()` handler), and **Webhook mode** (GitHub App webhook → `POST /v1/webhooks/github`). Webhook mode is shipped but **opt-in / off by default** — a deploy without `GITHUB_WEBHOOK_SECRET` returns `503` on that route; set the secret to enable it. "Live at HEAD" means shipped + runnable on your own `wrangler deploy` ([BYOC](05-byoc.md)) — there is no operator-hosted demo. Implementation has skipped around the V0–V4 roadmap deliberately — each run lands when its underlying capabilities + primitives compose without new platform plumbing.

---

## 1. `offload-test`

The walking-skeleton run. Clones a repo, executes a single command in a Sandbox, reports the exit code back to GHA as a check run.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,                       // "owner/name"
  sha: Schema.String,
  command: Schema.String,                    // e.g. "pnpm test"
  image: Schema.optional(Schema.String),     // override container image
  install: Schema.optionalWith(Schema.Boolean, { default: () => false }),
                                             // R2-cached dependency install (installCached) after the clone
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })), // non-sensitive only
  secrets: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
                                             // config-store keys → env vars (loadSecrets, required)
  secretPrefix: Schema.optional(Schema.String), // config-lookup prefix, e.g. "staging/"
  timeoutSec: Schema.optional(Schema.Number),// default 600
})
```

Credentials ride `secrets`/`secretPrefix` (resolved from the config store by `loadSecrets`, same contract as [`cdp-acceptance`](#4-cdp-acceptance)), never `env`: dispatch inputs are persisted (the `executions` row, Workflow params), so a secret in `env` would sit in storage at rest. On a key collision the per-dispatch `env` value wins over the config-store value.

`install: true` runs the lockfile-keyed, R2-cached dependency install (`installCached`, inside the `checkout` step via `workspace`) so the command doesn't open with its own cold `pnpm install` / `npm ci` / `cargo fetch` on every dispatch.

**Outputs:**

```ts
Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String,                     // signed R2 URL to step log
})
```

**Steps:** `checkout → exec → upload-log → finalize`

**Platform:** Sandbox, R2 (logs), D1, GitHub Check Runs.

**Limits:** `maxDurationSec: 1800` (wall-clock; Workflows steps have unlimited wall-clock per step but are bounded by per-Worker CPU — see [01-architecture](01-architecture.md#platform-limits--design-constraints)). Single container — no concurrency parameter.

---

## 2. `matrix-fanout`

> **Status: Live at HEAD.** Source: [`runs/matrix-fanout.ts`](../runs/matrix-fanout.ts), registered in [`registry.ts`](../apps/dispatcher/src/registry.ts). At HEAD the run body fans out **inline** via the [`sharded`](03-dsl.md#sharded) primitive — one container per shard inside the parent Workflow instance, exit codes aggregated into `passed` / `failed`. The cross-instance child-Workflow path is **also shipped**: the [`childRuns`](03-dsl.md#childruns) capability + the [`fanOut`](03-dsl.md#fanout) / [`waitForChildren`](03-dsl.md#waitforchildren) primitives spawn one independent child `RunWorkflow` per shard (each its own step budget + container + Browser session), backed by the `Workflow` binding wired in [`apps/dispatcher/src/workflow.ts`](../apps/dispatcher/src/workflow.ts) (#80). The `sharded` call is the seam: a run swaps from inline `Effect.forEach` to `fanOut` over `spawnChildRun` without changing its contract. `matrix-fanout` itself stays on inline `sharded` until a shard count exceeds the parent instance's per-instance budget; the contract below holds for either backing.

Executes the same command across N shards. Each shard reports its own exit code; the parent check is green only if every shard passes. Under the child-Workflow backing each shard is an independent child Workflow with its own check-run annotation.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  command: Schema.String,                    // receives SHARD_INDEX, SHARD_TOTAL env
  shards: Schema.Number,                     // 2..32
  image: Schema.optional(Schema.String),
  failureBehavior: Schema.optional(
    Schema.Literal("fail-fast", "wait-all"), // default "wait-all"
  ),
})
```

**Outputs:**

```ts
Schema.Struct({
  shardResults: Schema.Array(Schema.Struct({
    index: Schema.Number,
    exitCode: Schema.Number,
    durationMs: Schema.Number,
    logUri: Schema.String,
  })),
  passed: Schema.Number,
  failed: Schema.Number,
})
```

**Steps (inline `sharded`, HEAD):** `run-shards → (per shard) workspace → exec (SHARD_INDEX/SHARD_TOTAL env) → upload-log → aggregate exit codes`

**Steps (child-Workflow backing, via `fanOut`):** `plan → fanout (spawnChildRun per shard) → wait-for-children → summarize → finalize`; each child: `checkout → exec --shard ${i}/${n} → upload-log → report-via-own-check-run`

**Platform:** Sandbox (per shard), R2 (logs), D1, GitHub Check Runs. Under the child-Workflow backing: Workflows (one child `RunWorkflow` instance per shard via the `Workflow` binding) for spawning + result join by `parent_execution_id`; the account-level ceiling (container vCPU, concurrent Workflow instances) replaces the parent instance's per-instance step budget.

**Limits:** `maxConcurrency: 8` default. Under the child-Workflow backing each shard is its own `RunWorkflow` instance (`fanOut` → `spawnChildRun` → the `Workflow` binding's `create`, one per shard), bounded by the account-wide ceiling of 50,000 concurrent Workflow instances on Workers Paid — gated in practice by 1,500 vCPU of Container capacity; `maxDurationSec: 1800` per shard.

*Source:* https://developers.cloudflare.com/workflows/reference/limits/, https://developers.cloudflare.com/workflows/build/workers-api/, https://developers.cloudflare.com/containers/platform-details/limits/.

---

## 3. `playwright-e2e`

> **Status: Live at HEAD.** Source: [`runs/playwright-e2e.ts`](../runs/playwright-e2e.ts), registered in [`registry.ts`](../apps/dispatcher/src/registry.ts). One container per shard via the [`sharded`](03-dsl.md#sharded) primitive over `workspace({ install: true })`, each invoking `playwright test --shard=i/N`; `limits.requiresBrowser: true` declares the Browser Rendering binding (the suite's Playwright config dials CF Browser Rendering for the actual browser). Per-shard HTML reports upload to R2 as 30-day artifacts. The recipe at `recipes/browser-tests/playwright-e2e.run.ts` re-exports it for copy-paste.

Sharded Playwright executions using Browser Rendering for the page session and Sandbox for the test runner process. Each shard gets its own Browser Rendering session(s); test files are split via Playwright's native `--shard` flag.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  shards: Schema.Number,                     // default 4
  project: Schema.optional(Schema.String),   // Playwright project name
  testMatch: Schema.optional(Schema.String), // default "tests/**/*.spec.ts"
  baseURL: Schema.String,                    // URL of the app under test
  browserMode: Schema.optional(
    Schema.Literal("cf-browser-rendering", "in-container"),
  ),
  uploadReport: Schema.optional(Schema.Boolean), // default true
})
```

**Outputs:**

```ts
Schema.Struct({
  passed: Schema.Number,
  failed: Schema.Number,
  flaky: Schema.Number,
  duration: Schema.Number,
  reportUri: Schema.optional(Schema.String), // signed R2 URL to playwright-report
  shardResults: Schema.Array(/* ... */),
})
```

**Steps:** `plan → spawn-shards → per-shard:{checkout, install (cached), playwright test --shard i/N, upload-report-part} → merge-reports → upload-merged → finalize`

**Browser mode trade-off:**

| Mode | When | Cost | Throughput |
|---|---|---|---|
| `cf-browser-rendering` | Default. Stateless page tests. | 10 browser-hr/month included on Workers Paid, then $0.09 per additional browser-hr. Concurrent browsers averaged monthly: 10 included, $2.00 per additional. | 120 concurrent sessions per account on Workers Paid (higher on request) |
| `in-container` | Tests that need long sessions, custom Chromium flags, or unusual browser builds | Container vCPU-s + GiB-s only (\~$0.000020/vCPU-s, \~$0.0000025/GiB-s; 375 vCPU-min + 25 GiB-h included monthly) | Bounded by container concurrency, not browser pool |

**Platform:** Browser Rendering OR Sandbox-with-Playwright image, R2 (reports + traces), D1, Check Runs.

**Limits:** `maxConcurrency: 8` default; `maxDurationSec: 2400` per shard; `requiresBrowser: true` (for `cf-browser-rendering` mode).

*Source:* [Browser Rendering pricing](https://developers.cloudflare.com/browser-rendering/platform/pricing/), [Browser Rendering limits](https://developers.cloudflare.com/browser-rendering/platform/limits/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/). 2026-05.

---

## 4. `cdp-acceptance`

> **Status: Live.** Source: [`runs/cdp-acceptance.ts`](../runs/cdp-acceptance.ts). Rides on three live primitives — `workspace` (acquire + clone + cached install), `loadSecrets` (config-store credential injection), and `bootApp` (detached run + wait-for-port) — plus the `browser` capability over Browser Rendering CDP.

Acceptance tests that drive a running app via Chrome DevTools Protocol — the gctrl-board pattern. Boots the app under test in one container, attaches Browser Rendering via CDP, executes assertion scripts that combine UI interactions with CDP observations (network calls, console errors, document counts, heap deltas).

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  appBootCommand: Schema.String,             // e.g. "pnpm dev"
  appPort: Schema.Number,                    // e.g. 4173
  testCommand: Schema.String,                // e.g. "pnpm test:acceptance"
  kernelEndpoint: Schema.optional(Schema.String), // for gctrl-style kernel-backed apps
  seedFixtures: Schema.optional(Schema.Array(Schema.String)), // R2 paths to seed data
})
```

**Outputs:**

```ts
Schema.Struct({
  passed: Schema.Number,
  failed: Schema.Number,
  observations: Schema.Array(Schema.Unknown), // CDP observations captured
  reportUri: Schema.String,
})
```

**Steps:** `checkout → install → boot-app (detached container) → wait-ready → attach-cdp → run-tests → capture-observations → teardown → finalize`

**Platform:** Sandbox (app + test runner), Browser Rendering (CDP mode), R2 (observations + reports), D1, Check Runs.

**Limits:** `maxDurationSec: 1800`; one app boot per execution (no internal sharding — share boot cost across many tests by writing more tests, not more shards).

---

## 5. `product-demo`

> **Status: Live.** Source: [`runs/product-demo.ts`](../runs/product-demo.ts). The first run wired in both **Action mode** (recipe `ci.yml` on `pull_request` / `workflow_dispatch`) and **Schedule mode** (daily cron via `schedules[]` → Dispatcher `scheduled()` handler). No checkout — the target is a deployed URL, not the repo. Drives the site over a single CDP session with Browser Run's native rrweb session recording, shells out to the bundled `demo-agent` CLI for the per-story model loop, and uploads the rrweb event stream as an R2 artifact.

AI-driven product demo. A team hands it a deployed URL (preview / staging / prod) and a list of user stories as prose; the run drives the site through each story over a single CDP session, captures key screenshots, writes a per-story narrative, and produces a holistic markdown summary across all stories. When the dispatch carries a `pr` number, completion also posts one PR comment embedding an animated GIF of the walkthrough — see [§ PR comment on completion](#pr-comment-on-completion-gif--summary).

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,                       // check-run callback anchor
  sha: Schema.String,                        // check-run callback anchor
  deployedUrl: Schema.String,                // deployed URL (preview / staging / prod)
  // Supply exactly one story source (`stories` wins if both are present):
  stories: Schema.optional(Schema.Array(     //   structured story list
    Schema.Struct({ name: Schema.String, prose: Schema.String }),
  )),
  storiesMarkdown: Schema.optional(Schema.String), // markdown, each `## ` = one story
  viewportPreset: Schema.optional(Schema.Literal("desktop", "mobile")),
  maxDurationSecPerStory: Schema.optional(Schema.Number),
  pr: Schema.optional(Schema.Number),        // PR number — enables the completion comment (GIF + summary)
  installationId: Schema.optional(Schema.Number), // threaded when known; the github Layer resolves it per-repo otherwise
})
```

> **Story sources.** `stories` is the structured `{ name, prose }[]`. `storiesMarkdown` is a markdown doc where each level-2 heading (`## `) is one story (heading = `name`, body = `prose`); it's parsed into the same list before the agent runs, so an operator can keep the demo script as a readable `.md`. Story names must be unique (they're rrweb chapter markers); the run dies on duplicates or an empty resolved list. Model ids + `demo-agent` credentials resolve from `CONFIG_KV` (`product-demo.model.{play,summary}`, `product-demo.secret/*`), not from the input.

**Outputs:**

```ts
Schema.Struct({
  // Stories play IN PARALLEL, each on its OWN Browser Run CDP session (its own
  // rrweb recording), so the replay links are per-story rather than one shared
  // timeline.
  stories: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.Literal("passed", "failed"),
    durationMs: Schema.Number,
    chapterStartMs: Schema.Number,           // rrweb offsets within this story's recording
    chapterEndMs: Schema.Number,
    narrative: Schema.String,
    keyScreenshotUri: Schema.String,
    replayUri: Schema.String,                // docs-site rrweb player for this story
    replayJsonUri: Schema.String,            // signed R2 URL to this story's rrweb events
  })),
  replayUri: Schema.String,                  // first story that produced a replay
  replayJsonUri: Schema.String,
  summaryMd: Schema.String,                  // holistic Markdown summary (built in-run)
  gifUri: Schema.optional(Schema.String),    // stable artifact URL to the walkthrough GIF (absent if no frames / encode skipped)
})
```

**Steps:** `acquire → warmup → per story (parallel): { attach-cdp → record-start → play (+ per-action frame capture) → record-stop → upload-replay → upload-screenshot } → upload-summary → render-gif → upload-gif → post-pr-comment`

**Platform:** Browser Rendering (CDP + native rrweb recording), Sandbox (`demo-agent` shell-out for play + GIF encode), R2 (rrweb JSON + screenshots + GIF + summary), D1, Check Runs, GitHub PR comment (`github.pullReview`). No repo checkout.

**Trigger modes:** Action (recipe in `recipes/product-demo/`) and Schedule (`schedules[].cron` daily). See [04-gha-integration § Action mode](04-gha-integration.md#action-mode) and [§ Schedule mode](04-gha-integration.md#schedule-mode). Action mode threads `pr` from the workflow context to enable the completion comment; a Schedule-mode firing names no PR, so it never comments.

**Limits:** `maxDurationSec: 1800`; `requiresBrowser: true`.

### PR comment on completion (GIF + summary)

> **Status: Live at HEAD.** Source: [`runs/product-demo.ts`](../runs/product-demo.ts) (the `render-gif` / `upload-gif` / `post-pr-comment` steps + the `pr` / `installationId` inputs and `gifUri` output) and [`packages/demo-agent/src/gif.ts`](../packages/demo-agent/src/gif.ts) + the `play --frames-dir` capture. Dogfooded against this repo's own log viewer by [`.github/workflows/product-demo-logviewer.yml`](../.github/workflows/product-demo-logviewer.yml).

Whenever a `product-demo` execution **completes** — success or failure — and the dispatch carried a `pr` number, the run posts one top-level PR review comment via the existing [`github.pullReview`](03-dsl.md#github) write: the holistic `summaryMd` (the per-chapter status table), the `replayUri` link, and the walkthrough as an **animated GIF embedded inline** (`![product-demo walkthrough](gifUri)`). GitHub PR comments cannot embed video, but they render animated GIFs — this puts the demo itself in the review thread instead of behind a link. No new capability surface is needed: the comment rides the same deliberate write exception `pr-review` uses.

- **Frame source.** The rrweb recording is DOM events, not pixels — turning it into a GIF would mean replaying it in a browser. Instead each story's `demo-agent play` captures a pixel frame (`Page.captureScreenshot`) after every applied action into a shared `--frames-dir`, named `${story}-NNNN.png` so a glob sorts the chapters in order. Stories run in parallel on their own sessions, but at the run's `maxConcurrency: 1` they execute sequentially, so frames land in walkthrough order. Capture is best-effort — a missed frame never fails the story.
- **Encoding.** A `render-gif` step shells out to the `demo-agent gif` subcommand — pure-JS (`pngjs` decode + `gifenc` quantise/encode, bundled into the lean sandbox image, no ffmpeg/ImageMagick). It box-downscales to ≤ 800 px wide and holds the output under ≤ 10 MB (GitHub's camo image proxy won't render larger) by **dropping frames evenly first, then shrinking width** — never failing on an oversized input.
- **URL stability.** The comment embeds the dispatcher's stable artifact URL (`GET /v1/artifacts/:execution/demo.gif`, [§ r2-artifacts](#primitive-r2-artifacts)) with `image/gif` content type, never a raw presigned R2 URL — camo fetches it server-side, so the image keeps rendering after any presign would have rotated. The artifact route must be publicly readable on the deploy for camo to fetch it (the per-deploy public/private toggle); on a private deploy the embed shows broken and the comment's replay link still works.
- **Skip + failure semantics.** Same posture as [writeback](#writeback-runs-that-propose-prs): the comment is **best-effort reporting**. No `pr` on the dispatch → no comment, the check-run remains the report. A GIF-encode, upload, or comment-post failure logs (`io.log`) and is swallowed — it never flips the run's conclusion (which derives purely from how many chapters passed). A completion with zero captured frames posts the comment without the image. Each completion posts its own comment (matching `pullReview` semantics — the current run is authoritative).

---

## 6. `security-scan`

> **Status: Planned (V3).** Not shipped at HEAD — independent of `matrix-fanout`, but the parallel-scanner shape rides on the same `sharded` primitive that V1 work depends on.

Executes dependency / vulnerability scans against a checked-out repo. One run, multiple scanners selectable via input.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  scanners: Schema.Array(Schema.Literal(
    "npm-audit", "pnpm-audit", "cargo-audit", "uv-audit",
    "trivy-fs", "grype-fs", "gitleaks",
  )),
  severity: Schema.optional(Schema.Literal("low", "medium", "high", "critical")),
  failOn: Schema.optional(Schema.Literal("any", "high", "critical")), // default "high"
})
```

**Outputs:**

```ts
Schema.Struct({
  findings: Schema.Array(Schema.Struct({
    scanner: Schema.String,
    severity: Schema.String,
    cve: Schema.optional(Schema.String),
    package: Schema.String,
    summary: Schema.String,
  })),
  totalBySeverity: Schema.Record({ key: Schema.String, value: Schema.Number }),
  failed: Schema.Boolean,
})
```

**Steps:** `checkout → for each scanner: run-scanner → merge-findings → format-summary → finalize`

**Platform:** Sandbox (one container per scanner, parallel), R2 (raw scanner outputs), D1, Check Runs.

**Limits:** `maxDurationSec: 1200`; `maxConcurrency: 4` (scanner parallelism within one execution).

---

## 7. `custom-sandbox`

> **Status: Planned (V3).** Not shipped at HEAD — the surface is small once the `sandbox.exec` capability has a stable contract (which it does today), so this is a packaging concern, not a missing primitive.

Escape hatch. Execute an arbitrary bash script in a Sandbox container with the run's typed plumbing (checkout, env, log capture, check-run reporting) but no opinions about the workload.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  image: Schema.String,
  script: Schema.String,                     // bash; receives env + cwd=repo root
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  uploadPaths: Schema.optional(Schema.Array(Schema.String)), // globs to upload as artifacts
  timeoutSec: Schema.optional(Schema.Number),
})
```

**Outputs:**

```ts
Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String,
  artifactUris: Schema.Array(Schema.String),
})
```

**Steps:** `checkout → run-script → upload-artifacts → finalize`

**Platform:** Sandbox, R2, D1, Check Runs.

**Limits:** `maxDurationSec: 3600`.

This run exists to keep the cost of forking-a-run low: anything that doesn't fit a shipped run can execute here first, then graduate to its own typed run later.

---

## 10. `spec-drift-pr`

> **Status: Live (Schedule mode).** Source: [`runs/spec-drift-pr.ts`](../runs/spec-drift-pr.ts); recipe + docs in [`recipes/spec-drift-pr/`](../recipes/spec-drift-pr/). Daily (`0 5 * * *`), it scans each `spec-drift.repos` entry for drift between `specs/` and the implementation and opens a **draft PR** with the reconciling spec edits.

The detection reuses the `ai-code-review` engine: it resolves the configurable `workers-ai` backend under the `spec-drift.*` `CONFIG_KV` namespace and calls `@flare-dispatch/review-agent`'s `completeStructured` (the same tools/json + auto-fallback + Schema-validated path `pr-review` uses) with a drift-detection prompt the operator can override (`spec-drift.prompt`). The model returns full new spec-file contents; the run commits them via `github.openDraftPullRequest` (Git Data API, from the Worker — no container `git push`), idempotent on `flare-dispatch/spec-drift-<date>`. The one container image is used only for `git` (checkout + reading `specs/` + the file tree). See the recipe README for the full config contract and scope/limits.

## 11. `ci-triage-pr`

> **Status: Live (Schedule mode).** Source: [`runs/ci-triage-pr.ts`](../runs/ci-triage-pr.ts); recipe + docs in [`recipes/ci-triage-pr/`](../recipes/ci-triage-pr/). Daily (`0 6 * * *`), it reads recent CI failures across **GitHub Actions** (`github.actionRuns`) and **Cloudflare Pages** (`cloudflare.deployments`), triages them with a model, and opens one **draft PR** carrying the write-up (`.flare-dispatch/ci-triage-<date>.md`).

`github.actionRuns` and the new read-only `cloudflare` capability are the two read surfaces; the triage model call reuses the `ai-code-review` backend machinery under the `ci-triage.*` namespace (`completeStructured`, operator-overridable `ci-triage.prompt`); the PR is opened with `github.openDraftPullRequest`. A green day (no failures in `ci-triage.window-hours`) opens no PR and never calls the model. The run produces a triage diagnosis, not an automated fix. See the recipe README for the config contract and the `CLOUDFLARE_API_TOKEN` prerequisite.

## 12. `pr-review`

> **Status: Live at HEAD.** Source: [`runs/pr-review.ts`](../runs/pr-review.ts), registered in [`registry.ts`](../apps/dispatcher/src/registry.ts). A FlareDispatch port of Cloudflare's multi-agent code reviewer ([blog](https://blog.cloudflare.com/ai-code-review/)). The review runs **in the Worker**, not a container CLI: the body runs the `@flare-dispatch/review-agent` engine — either **one generalist reviewer** (`pr-review.agents=single`) or a **fan-out of one domain reviewer per concern** (`agents=multi`, the default) — each calling a model through the [`modelGateway`](03-dsl.md#modelgateway) capability. The one container image (`flare-dispatch-review`: Node + git) is used only for `git` (checkout + three-dot `base...head` diff). The backend is resolved from `CONFIG_KV` **without redeploy** — `workers-ai` (Workers AI catalog or `deepseek/` reasoner, binding-as-auth, no API key), `anthropic` (BYOK via AI Gateway), or `bedrock` (OIDC→STS→SigV4 via `awsAssumeRole`, no long-lived AWS key). A `"tools"`-mode backend that returns no tool calls auto-retries once in `"json"` mode.

Webhook-mode-first: fires on `pull_request` (`opened` / `synchronize` / `ready_for_review`), zero GHA minutes. The gate skips drafts (unless labelled `request-ai-review`), `skip-ai-review`-labelled PRs, and bot authors. Each push re-reviews the full PR diff independently — the current run is authoritative, so a fixed finding clears. The diff is noise-stripped + capped to the **resolved backend's** context window; the risk tier (a pure heuristic on diff size + touched paths) is always classified, and in `multi` mode it picks which domain reviewers run.

**Per-dispatch overrides (Action mode):** when dispatched by a GHA workflow (rather than the webhook), a single dispatch MAY override the `CONFIG_KV` defaults via the run inputs — `agents`, `backend`, `modelId`, `region`, `roleArn`, `focusArea`. Absent, the `CONFIG_KV` defaults apply (the webhook path is unchanged). This is the **model-bake-off / per-PR-escalation** path the former `multi-agent-review` run served — e.g. dispatch `backend: "bedrock"` + a `modelId` under test to compare a model on a real PR without touching `CONFIG_KV`. These inputs ride the HMAC-authenticated dispatch (operator-trusted), never the diff.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,                       // "owner/name"
  sha: Schema.String,                        // PR head sha
  baseSha: Schema.String,                    // PR base-branch tip (three-dot diff endpoint)
  pr: Schema.Number,                         // PR number
  installationId: Schema.optional(Schema.Number), // Webhook maps it from payload.installation.id
  // Per-dispatch overrides (Action mode) — absent → CONFIG_KV defaults apply:
  agents: Schema.optional(Schema.Literal("single", "multi")), // override pr-review.agents
  backend: Schema.optional(Schema.String),   // pin a backend for this dispatch
  modelId: Schema.optional(Schema.String),   // override the resolved backend's model
  region: Schema.optional(Schema.String),    // override the bedrock region
  roleArn: Schema.optional(Schema.String),   // override the bedrock IAM role ARN
  focusArea: Schema.optional(Schema.String), // extra focus line for the reviewer prompt
})
```

**Outputs:** the engine's `ReviewOutputSchema` — `{ verdict: "approve"|"comment"|"request-changes", tier, critical, warnings, suggestions, findings: { level, title, message, path, startLine, endLine }[] }`. `findings` become check-run annotations; the rest renders in the scannable PR comment (summary table + per-finding headings + GitHub blob links; operator-selectable `default` / `compact` style via `pr-review.style`).

**Steps:** `resolve-backend → checkout → prepare-diff → classify-risk → resolve-agents → resolve-prompt → resolve-style → [assume-bedrock-role] → review (one generalist, or fan out per domain) → coordinate → post-comment`. The whole body is wrapped in an error boundary that always posts a PR comment — success or failure — then re-fails honestly so the check goes red on a genuine error.

**Trigger modes:** Webhook (the registered trigger) + Action mode (HMAC dispatch; `installationId` then omitted unless threaded through).

**Platform:** Sandbox (git only), `modelGateway` (Workers AI binding / AI Gateway / Bedrock route), R2, D1, GitHub Check Runs + PR review comments.

**Limits:** `maxDurationSec: 1500`; `maxConcurrency` = the full domain-reviewer count.

## 13. `refresh-fixtures`

> **Status: Live at HEAD.** Source: [`runs/refresh-fixtures.ts`](../runs/refresh-fixtures.ts), registered in [`registry.ts`](../apps/dispatcher/src/registry.ts). The worked example for the [`writeback`](#writeback-runs-that-propose-prs) capability: the container runs an operator-supplied regeneration command, stages a changed-files manifest + blobs from `git status --porcelain`, and uploads them as the `writeback` directory artifact. It holds **no git/gh credential** and never pushes — after the run succeeds, the Dispatcher Worker validates the manifest against the `writeback` spec and commits it via the GitHub App as a branch + draft PR. An empty/absent manifest is a clean no-op.

**Inputs:**

```ts
Schema.Struct({
  repo: Schema.String,                       // "owner/name"
  sha: Schema.String,
  command: Schema.String,                    // the regeneration command (codegen / record / snapshot)
})
```

**Outputs:**

```ts
Schema.Struct({
  exitCode: Schema.Number,
  changedPaths: Schema.Array(Schema.String), // repo-relative paths staged for writeback (empty ⇒ no diff)
  writebackUri: Schema.String,               // the writeback artifact URL the Worker consumed
})
```

**Steps:** `checkout → regenerate → stage-writeback → upload-writeback`. The Worker's post-run writeback step (branch + commit + PR) is separate — see [§ Writeback](#writeback-runs-that-propose-prs).

**Writeback spec (declared in the run definition):** fixed bot branch `flare-dispatch/refresh-fixtures` (re-runs force-update it + the one open PR), a draft PR, and a `pathAllowlist` of `["fixtures/**", "**/__fixtures__/**", "**/*.snap"]` (`.github/workflows/**` stays gated — `allowWorkflows` defaults off).

**Platform:** Sandbox (git + the regeneration command), R2 (the `writeback` directory artifact), D1, GitHub Check Runs; the GitHub App's Git Data API for the Worker-side commit + PR.

**Limits:** `maxDurationSec: 1800`.
In **Action mode** (`POST /v1/dispatch/ci-triage-pr`) a consumer that owns its own scheduling can also pass caller-supplied **signals** — see [§ Signals](#signals) below.

---

## Signals

> **Status: Live (`signals/v1`).** Canonical contract: [`packages/core/src/signals.ts`](../packages/core/src/signals.ts). Language-agnostic JSON Schema artifact: [`schemas/signals.v1.schema.json`](../schemas/signals.v1.schema.json) (generated by `scripts/emit-signals-schema.mjs`; CI fails on drift). Producer-side collection is wired into the GHA dispatch Action via its [`collect-command`](04-gha-integration.md) input.

A **signal** is one normalized observability finding a *consumer* collected from a system the dispatcher's own read capabilities don't reach — an APM/tracing SaaS, runtime exception logs, health probes, an alert webhook. A run (today, [`ci-triage-pr`](#11-ci-triage-pr)) accepts an optional capped array of them as input and folds them into the same triage as the failures it read itself.

**The contract is the narrow waist.** The dispatcher stays *vendor-blind*: it never queries Datadog / SigNoz / HyperDX / CloudWatch / … and holds none of their credentials. Any vendor is supported on day one by a **consumer-side adapter** that emits this shape; vendor query logic, credentials, and severity semantics all live with the caller. This keeps the dispatcher a small, audited surface and lets the ecosystem of collectors grow without touching it.

### Shape (`signals/v1`)

Each signal is an object; the input is an array of them.

| Field | Type | Required | Cap | Meaning |
|---|---|---|---|---|
| `source` | string | yes | ≤ 120 chars | Which system produced it. Convention: `vendor-or-surface[:scope]` — e.g. `workers-observability:my-api`, `datadog:monitor`, `health-probe`. |
| `title` | string | yes | ≤ 200 chars | Short title naming the error. |
| `detail` | string | yes | ≤ 2000 chars | Enough context for a model to triage (message, window, counts). |
| `url` | string | no | ≤ 1000 chars | Optional deep link into the producing system. |
| `count` | number | no | — | Optional occurrence count over the caller's window. |

The whole array is capped at **50 items**. The caps bound a dispatch body well under the Cloudflare Workflows params ceiling (50 × ~2 KB detail ≈ 100 KB worst case) and turn an oversized dispatch into a clean **400 at the dispatch gate** (the Worker Schema-decodes `inputs` against this contract) instead of a silent overflow downstream.

### Producer contract

A collector / adapter (e.g. the thing behind the Action's `collect-command`) MUST:

1. **stdout is ONLY the JSON payload** — a `Signal[]`, or an object with a `signals` array property. Diagnostics, progress, and warnings go to **stderr**.
2. **Always exit 0 with a valid (possibly empty) array.** Each source the collector scans degrades to empty **independently** — a partial outage of one vendor still produces a dispatch with whatever else was observable. A signals-only day (no CI/deploy failures but real runtime errors) is *not* a green day; it still opens the triage PR.
3. **Respect the caps, by clustering not enumerating.** Emit one signal per failure *cluster*, not per raw event — group + truncate at the source rather than relying on the gate to reject an oversized payload.
4. **Severity is array order, worst first.** The contract carries no severity field; ordering is the only ranking it conveys.

### Versioning policy

- **Additive changes** — a new *optional* field — stay **`v1`** (existing consumers and the JSON Schema's `additionalProperties` posture remain compatible).
- **Renaming, removing, or tightening** a field is a **breaking change** → **`v2`**: a new schema and a new `SIGNALS_CONTRACT_VERSION`, never an in-place edit of `v1`. The version is surfaced as `SIGNALS_CONTRACT_VERSION` (TS) and `x-flare-dispatch-contract-version` (JSON Schema).

---

## Writeback: runs that propose PRs

> **Status: Live.** Any run can declare a `writeback` output ([`runs/refresh-fixtures.ts`](../runs/refresh-fixtures.ts) is the worked example). The run's container regenerates files and emits a changed-files manifest; after the run **succeeds**, the Dispatcher Worker turns that manifest into a commit + PR via the GitHub App's Git Data API.

Runs are output-only by design — containers boot with **no git or `gh` credential** and cannot push branches or open PRs. Writeback keeps that property while letting any run *propose* a diff. The split is the whole point: the container says *what* it would change; the **Worker** — the only place the GitHub App credentials live — decides whether to apply it and does the committing.

Motivating cases (all generic, deterministic regenerations a human reviews before merge):

- refreshing recorded-API-fixture snapshots against the live upstream;
- a dependency bump + lockfile regeneration;
- regenerating generated docs / API references from source;
- updating committed test snapshots.

### The contract

A run declares the capability in its **definition** (trusted, Worker-side — never assembled from container output):

```ts
defineRun({
  // …
  writeback: {
    branch: "flare-dispatch/refresh-fixtures",   // fixed bot branch; or { prefix } for a fresh branch per run
    baseBranch: "main",                          // optional; defaults to the dispatch ref / repo default
    commitMessage: "chore: refresh fixtures",
    pr: { title: "chore: refresh fixtures", body: "…", draft: true },  // or `false` to push the branch only
    updateExisting: true,                        // re-runs force-update the ref + the open PR (default)
    pathAllowlist: ["fixtures/**", "**/*.snap"], // only these paths may be written
    // allowWorkflows: true,                      // required to touch .github/workflows/** (App needs the `workflows` permission)
  },
});
```

The **container** writes its proposed edit to a conventional artifact location and uploads it as a directory artifact named `writeback`:

- `artifacts/writeback/manifest.json` — `{ "entries": [ { "path": "<repo-relative>", "mode"?: "100644"|"100755", "deleted"?: true }, … ] }`;
- `artifacts/writeback/files/<repo-relative path>` — the full new content for each non-deleted entry.

An **empty or absent** manifest is a clean **no-op** (most runs produce no diff) — never a failure.

### The Worker post-run step

On a successful run with a `writeback` spec, the Worker:

1. reads the manifest + blobs from R2 (the directory-artifact the container uploaded);
2. **validates** the manifest against the spec — rejects path traversal / absolute paths, enforces the `pathAllowlist`, the total-size cap, and the `.github/workflows/**` opt-in;
3. mints the GitHub App installation token and commits via the Git Data API — blob → tree (`base_tree` = head of the base branch) → commit → create-or-force-update the ref — then opens a PR (or updates the open one on a fixed branch). Deletions are `sha: null` tree entries; per-file modes carry through.

Idempotent across retries (force-update the ref, reuse the open PR), and runs in its own durable Workflow step so a Worker eviction mid-commit replays the recorded outcome. Writeback is **best-effort reporting**: a writeback failure logs + annotates the (already-green) check-run summary, never flips the run red. When App credentials are absent on the deploy, writeback is a logged skip.

### Security model

- **Credentials never enter the container.** The GitHub App private key lives only in the Worker; the container only ever writes files to its own artifact output.
- **Capability is declared, not inferred.** A run can only writeback if its *definition* says so; the container cannot widen the branch, base, allowlist, or workflow opt-in. The manifest is data the Worker validates, not config it trusts.
- **Path validation rejects escapes** (`..`, absolute, `./`, empty segments), enforces the `pathAllowlist` when declared, caps total bytes + file count, and gates `.github/workflows/**` behind an explicit per-run opt-in (which also requires granting the App the `workflows` permission).

---

## Primitive: `cache-pnpm` / `npm` / `cargo` / `uv`

Not a dispatch-able run — a DSL primitive composed inside other runs, exposed as [`installCached`](03-dsl.md#installcached). Looks up an R2 key derived from the relevant lockfile hash, downloads the archive into the container if present, executes the install command, and uploads the resulting cache if the key was missing.

```ts
// installCached is the primitive; cache.restoreOr is the capability it rides on.
yield* cache.restoreOr({
  key: yield* hashFile("pnpm-lock.yaml"),
  paths: ["node_modules", ".pnpm-store"],
  onMiss: () => sandbox.exec("pnpm install --frozen-lockfile"),
});
```

R2 keys are content-addressed by lockfile hash + image digest, so cache poisoning between environments is impossible. Cache entries have no TTL by default — R2 lifecycle policy on the deploy controls eviction (typical: 30 days since last access).

## Primitive: `r2-artifacts`

The `artifact` capability ([03-dsl § artifact](03-dsl.md#artifact)) — uploading artifacts and returning signed URLs that get embedded in the check-run summary.

```ts
const reportUrl = yield* artifact.upload({
  name: "playwright-report",
  path: "playwright-report/",        // file or directory; directories are tar.zst-ed
  contentType: "application/x-tar+zstd",
  signedUrlTTL: Duration.days(30),
});
// reportUrl is a signed R2 URL embedded in the check-run output.
```

Signed URLs are issued by the dispatcher's `GET /v1/artifacts/:execution/:name` endpoint, which performs auth (public/private toggle per-deploy) and 302-redirects to a short-lived R2 presigned URL. This keeps artifact URLs stable even if R2 keys rotate.

---

## Naming + versioning rules

- Run names are kebab-case, lowercase, stable. Renames require a deprecation alias.
- The DSL package and the run package version independently. Runs pin the DSL version they were tested against.
- A run's input/output Schemas are part of its public API. Breaking changes bump major version. GHA Action references can pin to `@v2` to opt into new majors.
