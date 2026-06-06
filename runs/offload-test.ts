// `offload-test` — the FlareDispatch V0 walking-skeleton run.
//
// Clones a repo, runs a single command in a Sandbox container, uploads the
// command's log to R2, and returns the exit code + duration + log URL. This is
// the run the V0 acceptance criterion exercises: a `pnpm test` executing in CF
// Sandbox reporting green/red back to a PR check.
//
// Contract — inputs/outputs per specs/02-runs.md § 1. Body shape per
// specs/03-dsl.md § Top-level shape: `checkout → exec → upload-log`.
//
// --- Three design decisions, documented inline -------------------------------
//
// 1. No `finalize` step in the run body.
//    specs/02-runs.md § 1 lists the steps as `checkout → exec → upload-log →
//    finalize`, but `finalize` is *not* a run-body concern: it is the D1
//    `executions`-row status write and the GitHub check-run callback, both of
//    which are runtime/Workflow plumbing, not run logic. The `RunWorkflow`
//    class (PR4) owns that boundary — it maps the run's terminal Exit to the
//    `executions` status + the check-run conclusion *after* the run Effect
//    returns. Keeping `finalize` out of the run body keeps the run pure,
//    portable, and testable against `CFRuntimeTest` with no Checks/Executions
//    assertions. The run-body steps are therefore exactly the three from
//    specs/03-dsl.md § Top-level shape.
//
// 2. `durationMs` comes from the `exec` step's `ExecResult` — `result.durationMs`.
//    This is what specs/03-dsl.md § Top-level shape sketches, and it is the
//    replay-safe source: only `step(...)` results are checkpointed/memoized by
//    the CF Workflow, so on replay `result` is restored from the checkpoint
//    identically. Anything read *outside* a step (e.g. an `io.now` in the run
//    body) re-executes on every replay and would yield a fresh value — not
//    replay-deterministic. Sourcing `durationMs` from the checkpointed exec
//    result keeps the run's output stable across replays. No `Date.now()` /
//    `crypto.randomUUID()` is called in the run body.
//
// 3. Credentials come from the config store via `loadSecrets`, never the
//    dispatch body. The `env` input is for non-sensitive values only: dispatch
//    inputs are persisted (the `executions` row, Workflow params), so a secret
//    riding `env` would sit in storage at rest. A command that needs
//    credentials names config-store keys in `secrets` (+ `secretPrefix`) and
//    the run resolves them with `loadSecrets({ required: true })` — same
//    contract as `cdp-acceptance` (see its header note 1). `loadSecrets` is
//    called INLINE, not in a `step(...)`: step results are checkpointed to
//    durable Workflow storage, and plaintext credentials must not land there
//    either. The config read is cheap + idempotent to re-run on replay.
//
// Spec: specs/02-runs.md § 1, specs/03-dsl.md § Top-level shape + § sandbox,
//       specs/pm/plan.md § PR3.

import { Effect, Schema } from "effect";
import { artifact, defineRun, sandbox, step } from "@flare-dispatch/core";
import { loadSecrets } from "@flare-dispatch/core/primitives";

/** Input contract — specs/02-runs.md § 1. */
const OffloadTestInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  command: Schema.String, // e.g. "pnpm test"
  image: Schema.optional(Schema.String), // override container image
  /** Non-sensitive env only — dispatch inputs are persisted (header note 3). */
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  /**
   * Config-store keys whose values are injected — as env vars of the same
   * name — into the command's env. Empty when the command needs no
   * credentials. See `loadSecrets` + header note 3.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Prefix prepended to each `secrets` key for the config lookup. */
  secretPrefix: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number), // default 600
});

/** Output contract — specs/02-runs.md § 1. */
const OffloadTestOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  logUri: Schema.String, // signed R2 URL to the step log
});

/** Default `exec` timeout when the caller omits `timeoutSec`. */
const DEFAULT_TIMEOUT_SEC = 600;

export const offloadTest = defineRun({
  name: "offload-test",
  version: "1.0.0",

  inputs: OffloadTestInput,
  outputs: OffloadTestOutput,

  limits: {
    // Wall-time ceiling — specs/02-runs.md § 1. Single container, no
    // concurrency parameter.
    maxDurationSec: 1800,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — clone the repo at the requested SHA into a fresh container.
      const repoDir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha }),
      );

      // load-secrets — resolve the named credentials from the config store
      // into the env injected below. Called INLINE, not in a `step`: secrets
      // must not land in a durable Workflow checkpoint (see header note 3).
      // A no-op (empty record) when `secrets` is empty.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // exec — run the command. A non-zero exit code is a NORMAL ExecResult
      // (a failing test), surfaced to the output below — never an Effect
      // failure. `sandbox.exec` fails its Effect only with ExecFailed /
      // ExecTimeout, which propagate out of the run unchanged. `result` is the
      // checkpointed step output — replay restores it identically, which is
      // why the run's `durationMs` is read from it (see header note 2).
      const result = yield* step("exec", () =>
        sandbox.exec({
          cwd: repoDir,
          command: input.command,
          // Per-dispatch `env` wins over a same-named config-store secret —
          // the more specific source overrides the global one.
          env: { ...secretEnv, ...input.env },
          timeoutSec: input.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        }),
      );

      // upload-log — push the captured stdout/stderr to R2, get a signed URL.
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
