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
// --- Two design decisions, documented inline ---------------------------------
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
// 2. `durationMs` is computed from `io.now`, not taken from `ExecResult`.
//    The run brackets the `exec` step with two `io.now` reads and reports the
//    delta. Non-determinism must flow through `io` so Workflow checkpoint
//    replay is consistent (specs/03-dsl.md § step Rules; specs/pm/plan.md
//    § 6). `ExecResult.durationMs` is the container's own measurement and is
//    kept for the sandbox runtime's own telemetry, but the run-level
//    `durationMs` output is the `io.now`-bracketed wall time — the value a
//    replay can reproduce. No `Date.now()` / `crypto.randomUUID()` is called.
//
// Spec: specs/02-runs.md § 1, specs/03-dsl.md § Top-level shape + § sandbox,
//       specs/pm/plan.md § PR3.

import { Effect, Schema } from "effect";
import { artifact, defineRun, io, sandbox, step } from "@flare-dispatch/core";

/** Input contract — specs/02-runs.md § 1. */
const OffloadTestInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  command: Schema.String, // e.g. "pnpm test"
  image: Schema.optional(Schema.String), // override container image
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
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

      // exec — run the command. A non-zero exit code is a NORMAL ExecResult
      // (a failing test), surfaced to the output below — never an Effect
      // failure. `sandbox.exec` fails its Effect only with ExecFailed /
      // ExecTimeout, which propagate out of the run unchanged.
      //
      // The exec step is bracketed with `io.now` so the run-level `durationMs`
      // is a replay-deterministic measurement (see the header note).
      const startedAt = yield* io.now;
      const result = yield* step("exec", () =>
        sandbox.exec({
          cwd: repoDir,
          command: input.command,
          env: input.env,
          timeoutSec: input.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        }),
      );
      const finishedAt = yield* io.now;

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
        durationMs: finishedAt - startedAt,
        logUri,
      };
    }),
});
