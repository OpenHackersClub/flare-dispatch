# 03 — DSL

Recipes are Effect-TS programs. The DSL is a small surface — `defineRecipe`, `step`, and five capability namespaces (`sandbox`, `browser`, `cache`, `artifact`, `io`) — wired together by Effect Layers so the same recipe code runs against the live CF stack, against `wrangler dev` locally, and against in-memory test fakes.

## Why Effect-TS and not YAML / a custom config schema

- **Typed inputs and outputs end-to-end.** `Schema` defines the contract; TypeScript checks the recipe body against it. Misspell a field and the build fails — not on shard 5 at 2am.
- **Tagged errors per failure mode.** `CheckoutFailed`, `InstallTimeout`, `BrowserCrashed`, `CacheMiss` are distinct types. `Effect.catchTag` recovers selectively; everything else propagates with full cause information.
- **Retry policies as data.** `Effect.retry(schedule)` with `Schedule.exponential` + `Schedule.recurs` + `Schedule.whileInput` composes retry behavior without hand-rolled loops. See `## Effect-TS Programming` in the project CLAUDE.md.
- **Layers swap implementations.** The same recipe runs against real Sandbox in prod and against an in-process container fake in unit tests — recipes become directly testable without spinning up CF.
- **No YAML escaping hell.** Multi-line scripts, JSON inputs, and template strings live in TypeScript, not stringly-typed config.

## Top-level shape

```ts
import { Effect, Schema } from "effect";
import { defineRecipe, step, sandbox, cache, artifact } from "@cf-recipes/core";

export const offloadTest = defineRecipe({
  name: "offload-test",
  version: "1.0.0",

  inputs: Schema.Struct({
    repo: Schema.String,
    sha: Schema.String,
    command: Schema.String,
    timeoutSec: Schema.optional(Schema.Number),
  }),

  outputs: Schema.Struct({
    exitCode: Schema.Number,
    durationMs: Schema.Number,
    logUri: Schema.String,
  }),

  limits: {
    maxDurationSec: 1800,
  },

  run: (input) =>
    Effect.gen(function* () {
      const repoDir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha }),
      );

      const result = yield* step("exec", () =>
        sandbox.exec({
          cwd: repoDir,
          command: input.command,
          timeoutSec: input.timeoutSec ?? 600,
        }),
      );

      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "step.log",
          path: result.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      return {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logUri,
      };
    }),
});
```

A recipe is just an object. The `run` function is an `Effect` that, when executed by the runtime, produces the typed output.

## `defineRecipe`

```ts
declare const defineRecipe: <I, O, IEnc, OEnc>(
  spec: {
    name: string;
    version: string;
    inputs: Schema.Schema<I, IEnc>;
    outputs: Schema.Schema<O, OEnc>;
    limits: RecipeLimits;
    run: (input: I) => Effect.Effect<O, RecipeError, RecipeContext>;
  },
) => Recipe<I, O>;
```

`defineRecipe` is a passive constructor — it validates the spec at module load and registers it for discovery. It doesn't bind to any runtime; the same `Recipe` value is portable.

## `step`

Wraps an Effect in a Workflow checkpoint. Each `step` call becomes a `WorkflowStep.do(...)` in the underlying CF Workflow — durable, retryable, and individually logged.

```ts
declare const step: <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, RecipeContext>,
  opts?: {
    retries?: number;                        // platform-level retry on infra failure
    timeoutSec?: number;
    metadata?: Record<string, unknown>;      // attached to the step record in D1
  },
) => Effect.Effect<A, E | StepFailed, RecipeContext>;
```

Steps are the only durable boundary. Inside a step, Effects compose freely without persistence — checkpoints happen at step exit, not at every `yield*`. This matches Workflow semantics: step is the atom of retry.

**Rules:**

1. A step body must be deterministic given its inputs and prior outputs. Non-determinism (random IDs, current time, env reads) goes through `io.now()` / `io.uuid()` / `io.env()` so the runtime can replay it from the checkpoint.
2. Step names must be unique within a recipe — they're the dedup key for checkpoint replay.
3. A step that needs to retry on a specific error catches with `Effect.catchTag` *inside* the step body and re-fails as a different tag (or recovers). Platform-level retry handles transient infra errors only.

## Capability namespaces

All side-effectful operations live in one of these namespaces. Each is a `Context.Tag`-defined service backed by a Layer (real / dev / test).

### `sandbox`

Container execution.

```ts
namespace sandbox {
  // Acquire a container; auto-released at recipe end.
  declare const acquire: (opts: { image?: string; memMB?: number; vCPU?: number }) =>
    Effect.Effect<Container, ContainerLaunchFailed>;

  // Convenience: clone a repo into a fresh container, return its path.
  declare const git: {
    clone: (opts: { repo: string; sha: string; container?: Container }) =>
      Effect.Effect<string /* repoDir */, GitFailed>;
  };

  // Run a command in a container.
  declare const exec: (opts: {
    cwd?: string;
    command: string | readonly string[];
    env?: Record<string, string>;
    timeoutSec?: number;
    container?: Container;
  }) => Effect.Effect<ExecResult, ExecFailed | ExecTimeout>;

  // Detached mode for long-running processes (app boot during cdp-acceptance).
  declare const runDetached: (opts: ExecOpts) =>
    Effect.Effect<DetachedHandle, ContainerLaunchFailed>;

  declare const waitForExit: (opts: { handle: DetachedHandle; pollEvery?: Duration }) =>
    Effect.Effect<ExecResult, ExecTimeout>;

  declare const waitForPort: (opts: { handle: DetachedHandle; port: number; timeoutSec?: number }) =>
    Effect.Effect<void, PortNeverOpened>;
}
```

`ExecResult` carries `exitCode`, `durationMs`, `logPath` (R2 key for the captured stdout/stderr), and a `stdout`/`stderr` *tail* (last N KB inlined for convenience; full log streamed to R2).

### `browser`

Browser Rendering access.

```ts
namespace browser {
  // REST mode — short, stateless page interactions.
  declare const newPage: (opts?: { viewport?: { w: number; h: number } }) =>
    Effect.Effect<Page, BrowserUnavailable>;

  // CDP mode — direct WebSocket to a managed Chromium.
  declare const newCDPSession: (opts: { targetUrl: string }) =>
    Effect.Effect<CDPSession, BrowserUnavailable>;
}
```

A `Page` wraps Puppeteer's page object with Effect signatures (`page.goto`, `page.click`, `page.evaluate` all return Effects with tagged errors). A `CDPSession` exposes typed `Network.*`, `Page.*`, `Runtime.*` event streams as Effect Streams.

### `cache`

R2-backed restore/save.

```ts
namespace cache {
  declare const restoreOr: <A, E>(opts: {
    key: string;                             // content-addressed; lockfile hash
    paths: readonly string[];                // files/dirs to cache, relative to container cwd
    onMiss: () => Effect.Effect<A, E, RecipeContext>;
    container: Container;
  }) => Effect.Effect<A, E | CacheError, RecipeContext>;

  declare const save: (opts: {
    key: string;
    paths: readonly string[];
    container: Container;
  }) => Effect.Effect<void, CacheError, RecipeContext>;
}
```

`restoreOr` is the canonical pattern: try to restore; if missing, run the `onMiss` effect (which presumably populates the paths) then save. Idempotent across reruns.

### `artifact`

R2-backed artifact upload with signed URLs.

```ts
namespace artifact {
  declare const upload: (opts: {
    name: string;
    path: string;                            // file or directory (dir tars to .tar.zst)
    contentType?: string;
    signedUrlTTL?: Duration | string;
    container?: Container;
  }) => Effect.Effect<string /* signed URL */, ArtifactUploadFailed, RecipeContext>;

  declare const list: (opts: { runId: string }) =>
    Effect.Effect<readonly ArtifactInfo[], never, RecipeContext>;
}
```

### `io`

Effect-friendly access to non-deterministic primitives. Must be used instead of `Date.now()` / `crypto.randomUUID()` / `process.env` so step replay is deterministic.

```ts
namespace io {
  declare const now: Effect.Effect<number, never, RecipeContext>;
  declare const uuid: Effect.Effect<string, never, RecipeContext>;
  declare const env: (key: string) => Effect.Effect<string | undefined, never, RecipeContext>;
  declare const sleep: (d: Duration) => Effect.Effect<void, never, RecipeContext>;
  declare const log: (level: "debug" | "info" | "warn" | "error", msg: string, attrs?: Record<string, unknown>) =>
    Effect.Effect<void, never, RecipeContext>;
}
```

## Errors

All recipe errors are `Schema.TaggedError`s, defined in `@cf-recipes/core/errors`:

```ts
export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()(
  "CheckoutFailed",
  { repo: Schema.String, sha: Schema.String, cause: Schema.Unknown },
) {}

export class ExecFailed extends Schema.TaggedError<ExecFailed>()(
  "ExecFailed",
  { exitCode: Schema.Number, stderrTail: Schema.String },
) {}

export class ExecTimeout extends Schema.TaggedError<ExecTimeout>()(
  "ExecTimeout",
  { timeoutSec: Schema.Number, command: Schema.String },
) {}

export class ContainerLaunchFailed extends Schema.TaggedError<ContainerLaunchFailed>()(
  "ContainerLaunchFailed",
  { image: Schema.String, cause: Schema.Unknown },
) {}

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { reason: Schema.Literal("quota", "transient", "session-cap"), retryAfterMs: Schema.optional(Schema.Number) },
) {}

export class CacheError extends Schema.TaggedError<CacheError>()(
  "CacheError",
  { phase: Schema.Literal("restore", "save"), key: Schema.String, cause: Schema.Unknown },
) {}

export class ArtifactUploadFailed extends Schema.TaggedError<ArtifactUploadFailed>()(
  "ArtifactUploadFailed",
  { name: Schema.String, cause: Schema.Unknown },
) {}

export class StepFailed extends Schema.TaggedError<StepFailed>()(
  "StepFailed",
  { step: Schema.String, cause: Schema.Unknown },
) {}

export type RecipeError =
  | CheckoutFailed | ExecFailed | ExecTimeout
  | ContainerLaunchFailed | BrowserUnavailable
  | CacheError | ArtifactUploadFailed | StepFailed;
```

Recipes recover with `Effect.catchTag` / `Effect.catchTags`. Anything not caught fails the run with the full Cause attached to the check-run summary.

## Retry patterns

Transient infra errors (BrowserUnavailable with `reason: "transient"`, ExecFailed with networky exit codes, container launch flakes) should retry; deterministic failures (test failures, ExecFailed with `exit !=0` from the user's command) should not.

```ts
import { Effect, Schedule } from "effect";

const launchPlaywright = browser.newCDPSession({ targetUrl }).pipe(
  Effect.retry(
    Schedule.exponential("500 millis").pipe(
      Schedule.intersect(Schedule.recurs(4)),
      Schedule.whileInput((e: BrowserUnavailable) => e.reason === "transient"),
    ),
  ),
);
```

`Schedule.whileInput` accesses `_tag` indirectly through the predicate — this is the documented Schedule API, not a branching escape hatch (see CLAUDE.md `Effect-TS Programming § Anti-patterns`).

## Pattern matching

Recipe authors converting tagged outcomes to summaries use `Match.tag` + `Match.exhaustive`:

```ts
import { Match } from "effect";

const summarize = (e: RecipeError): string =>
  Match.value(e).pipe(
    Match.tag("CheckoutFailed", ({ repo, sha }) => `Could not check out ${repo}@${sha}`),
    Match.tag("ExecFailed", ({ exitCode, stderrTail }) => `Command exited ${exitCode}\n${stderrTail}`),
    Match.tag("ExecTimeout", ({ timeoutSec, command }) => `Timed out after ${timeoutSec}s: ${command}`),
    Match.tag("ContainerLaunchFailed", ({ image }) => `Could not launch container ${image}`),
    Match.tag("BrowserUnavailable", ({ reason }) => `Browser unavailable (${reason})`),
    Match.tag("CacheError", ({ phase, key }) => `Cache ${phase} failed for key ${key}`),
    Match.tag("ArtifactUploadFailed", ({ name }) => `Artifact upload failed: ${name}`),
    Match.tag("StepFailed", ({ step }) => `Step "${step}" failed`),
    Match.exhaustive,
  );
```

`Match.exhaustive` ensures adding a new `RecipeError` variant is a compile error until every summary path handles it.

## Layers — how the recipe binds to runtimes

```ts
// Production: wires sandbox → Cloudflare Containers, browser → Browser Rendering, etc.
export const CFRuntimeLive = Layer.mergeAll(
  SandboxCloudflareLive,
  BrowserRenderingLive,
  R2CacheLive,
  R2ArtifactLive,
  D1IOLive,
);

// Local dev: wires sandbox → local Docker via wrangler dev miniflare, browser → local Chromium.
export const CFRuntimeDev = Layer.mergeAll(
  SandboxLocalDockerLive,
  BrowserPuppeteerLocalLive,
  R2LocalLive,
  R2ArtifactLocalLive,
  D1LocalLive,
);

// Test: in-memory fakes.
export const CFRuntimeTest = Layer.mergeAll(
  SandboxFake,
  BrowserFake,
  CacheFake,
  ArtifactFake,
  IOFake,
);
```

The same recipe runs against any of these:

```ts
import { Effect } from "effect";
import { CFRuntimeLive } from "@cf-recipes/runtime-cf";
import { offloadTest } from "./recipes/offload-test";

const program = offloadTest.run({
  repo: "owner/name",
  sha: "abc123",
  command: "pnpm test",
});

Effect.runPromise(program.pipe(Effect.provide(CFRuntimeLive)));
```

## Unit-testing recipes

```ts
import { it, expect, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { offloadTest } from "./offload-test";
import { CFRuntimeTest, sandboxFakeProgram } from "@cf-recipes/runtime-test";

it.effect("offload-test reports exit code from sandbox exec", () =>
  Effect.gen(function* () {
    const fakeSandbox = sandboxFakeProgram({
      "git clone": { exitCode: 0 },
      "pnpm test": { exitCode: 1, stderrTail: "1 failing" },
    });

    const result = yield* offloadTest.run({
      repo: "owner/name",
      sha: "abc",
      command: "pnpm test",
    });

    expect(result.exitCode).toBe(1);
  }).pipe(Effect.provide(Layer.merge(CFRuntimeTest, fakeSandbox))),
);
```

Recipe tests run in `vitest` without touching CF, Docker, or the network. Catches the bulk of recipe bugs before any container ever boots.

## Worked example — `playwright-e2e` (abbreviated)

```ts
export const playwrightE2E = defineRecipe({
  name: "playwright-e2e",
  version: "1.0.0",
  inputs: PlaywrightInput,
  outputs: PlaywrightOutput,
  limits: { maxDurationSec: 2400, maxConcurrency: 8, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      const shardPlan = yield* step("plan", () =>
        Effect.succeed(
          Array.from({ length: input.shards }, (_, i) => ({ index: i + 1, total: input.shards })),
        ),
      );

      const shardResults = yield* step("fanout", () =>
        Effect.forEach(
          shardPlan,
          (shard) =>
            spawnChildRecipe({
              recipe: "playwright-e2e-shard",
              input: { ...input, shard },
            }),
          { concurrency: input.shards },
        ),
      );

      const reportUri = yield* step("merge-reports", () =>
        mergeAndUploadReports(shardResults),
      );

      return summarizeShards(shardResults, reportUri);
    }).pipe(
      Effect.catchTag("BrowserUnavailable", (e) =>
        e.reason === "quota"
          ? Effect.fail(new BrowserQuotaExhausted({ retryAfterMs: e.retryAfterMs ?? 60_000 }))
          : Effect.fail(e),
      ),
    ),
});
```

The shard child is a separate recipe (`playwright-e2e-shard`), kept thin: clone, install (cached), `playwright test --shard i/N`, upload partial report.
