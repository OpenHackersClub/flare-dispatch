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
  image?: string;                            // default container image
  limits: {
    maxDurationSec: number;                  // wall-time ceiling
    maxConcurrency?: number;                 // shards or parallel executions
    requiresBrowser?: boolean;               // declares Browser Rendering binding
  };
  triggers?: TriggerSpec<I>[];                // Webhook-mode trigger config
  schedules?: ScheduleSpec<I>[];              // Schedule-mode trigger config (cron)
  run: (input: I) => Effect.Effect<O, RunError, RunContext>;
}
```

A user-defined run in their own repo has the same shape. The shipped runs below are the starter library. `triggers` / `schedules` are both optional and select the run's trigger mode — see [03-dsl § `defineRun`](03-dsl.md#definerun).

---

## Catalog

| | Run | When to use | Status |
|---|---|---|---|
| 1 | [`offload-test`](#1-offload-test) | Single command, single container, pass/fail back to GHA | V0 |
| 2 | [`matrix-fanout`](#2-matrix-fanout) | Same command across N shards in parallel | V1 |
| 3 | [`playwright-e2e`](#3-playwright-e2e) | Sharded Playwright tests with browser pool | V2 |
| 4 | [`cdp-acceptance`](#4-cdp-acceptance) | Boot an app + assert via CDP observations | V2 |
| 5 | [`security-scan`](#5-security-scan) | `npm audit` / `cargo audit` / `trivy` / `grype` | V3 |
| 6 | [`custom-sandbox`](#6-custom-sandbox) | Escape hatch — run any bash in a container | V3 |
| — | [`cache-*`](#primitive-cache-pnpm--npm--cargo--uv) | Primitive — R2-backed package cache (`installCached`) | V1 |
| — | [`r2-artifacts`](#primitive-r2-artifacts) | Primitive — artifact upload + signed URLs (`artifact`) | V1 |

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
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  timeoutSec: Schema.optional(Schema.Number),// default 600
})
```

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

Executes the same command across N shards. Each shard is an independent child Workflow with its own check-run annotation. Result: one parent check that's green only if all shards pass.

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

**Steps (parent):** `plan → spawn-shards (createBatch) → await-completion → summarize → finalize`

**Steps (child, per shard):** `checkout → exec --shard ${i}/${n} → upload-log → report-to-coordinator`

**Platform:** Sandbox (per shard), Workflows `createBatch` (up to 100 children per call) for spawning, Durable Object (Coordinator DO) for result aggregation, R2, D1, GitHub Check Runs. Queues only used when shard count × dispatch rate would exceed Workflows' per-workflow instance-creation rate of 100/s.

**Limits:** `maxConcurrency: 8` default (overridable up to 100 per `createBatch` call; account-wide ceiling is 50,000 concurrent Workflow instances on Workers Paid, gated in practice by 1,500 vCPU of Container capacity); `maxDurationSec: 1800` per shard.

*Source:* https://developers.cloudflare.com/workflows/reference/limits/, https://developers.cloudflare.com/workflows/build/workers-api/, https://developers.cloudflare.com/containers/platform-details/limits/.

---

## 3. `playwright-e2e`

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

## 5. `security-scan`

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

## 6. `custom-sandbox`

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
