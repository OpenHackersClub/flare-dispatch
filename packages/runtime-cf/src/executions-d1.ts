// @flare-dispatch/runtime-cf — D1ExecutionsLive: the live `executions` capability.
//
// Backs `ExecutionsService` with the D1 binding: one row in `executions` per
// run invocation, one row in `steps` per step transition (INSERT at entry,
// UPDATE at exit). Schema is infra/d1-schema.sql verbatim.
//
// --- One design seam, documented ---------------------------------------------
//
// `ExecutionsService.startExecution` (defined in @flare-dispatch/core) carries
// only `{ id, run, startedAt }`, but the `executions` table has NOT NULL
// `repo`, `ref`, `sha`, `input_json`, `status` columns. The core interface is
// fixed and run-agnostic, so the missing columns are supplied *out of band*:
// `makeD1ExecutionsLive` takes an `ExecutionContext` ({ repo, ref, sha, input })
// that `RunWorkflow` derives from the dispatch event. The Layer closes over it;
// `startExecution` then has every NOT NULL column. This keeps the core service
// contract narrow while satisfying the real schema — the Layer is the place
// runtime-specific context is injected.
//
// D1 write rate (specs/pm/plan.md § 6): this runtime writes exactly two D1
// statements per step (one INSERT, one UPDATE) plus two for the execution.
// `offload-test` (3 run-body steps) is therefore 8 writes — the PR4 integration
// test pins this with a row-count assertion.
//
// Spec: specs/05-byoc.md § D1 schema, specs/pm/plan.md § PR4.

import { Effect, Layer } from "effect";
import { Executions, type ExecutionsService } from "@flare-dispatch/core";

/**
 * The run-invocation context the `executions` row needs but the core
 * `ExecutionsService` interface does not carry — supplied by `RunWorkflow`
 * from the dispatch event.
 */
export type ExecutionContext = {
  /** "owner/name". */
  readonly repo: string;
  /** git ref, e.g. "refs/heads/main". */
  readonly ref: string;
  /** head SHA. */
  readonly sha: string;
  /** the decoded run input, persisted as `input_json`. */
  readonly input: unknown;
};

/**
 * Build the live `Executions` Layer bound to a D1 database.
 *
 * @param db   the D1 binding (`env.RUNS_METADATA`).
 * @param ctx  the repo/ref/sha/input the `executions` row requires.
 */
export const makeD1ExecutionsLive = (
  db: D1Database,
  ctx: ExecutionContext,
): Layer.Layer<Executions> => {
  // A D1 write wrapped as an Effect — `tryPromise` keeps a binding failure in
  // the Effect channel rather than escaping as a rejected Promise. The service
  // contract is `Effect.Effect<void>` (no typed error), so a write failure
  // surfaces as a defect: a D1 outage mid-run is genuinely exceptional and
  // should fail the execution loudly, not be silently swallowed.
  const run = (
    label: string,
    stmt: () => Promise<D1Result | D1Response>,
  ): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => stmt().then(() => undefined),
      catch: (cause) =>
        new Error(`D1ExecutionsLive: ${label} failed`, { cause }),
    }).pipe(Effect.orDie);

  const service: ExecutionsService = {
    startExecution: ({ id, run: runName, startedAt }) =>
      run("startExecution", () =>
        db
          .prepare(
            `INSERT INTO executions
               (id, run, repo, ref, sha, status, started_at, input_json)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
          )
          .bind(
            id,
            runName,
            ctx.repo,
            ctx.ref,
            ctx.sha,
            startedAt,
            JSON.stringify(ctx.input),
          )
          .run(),
      ),

    finishExecution: ({ id, completedAt, status }) =>
      run("finishExecution", () =>
        db
          .prepare(
            `UPDATE executions
               SET status = ?, completed_at = ?
             WHERE id = ?`,
          )
          .bind(status, completedAt, id)
          .run(),
      ),

    startStep: ({ executionId, name, startedAt }) =>
      run("startStep", () =>
        db
          .prepare(
            `INSERT INTO steps
               (id, execution_id, name, status, started_at, attempt)
             VALUES (?, ?, ?, 'running', ?, 1)`,
          )
          // The `steps` PK is a fresh id; (execution_id, name) is the logical
          // key the UPDATE in `finishStep` targets.
          .bind(crypto.randomUUID(), executionId, name, startedAt)
          .run(),
      ),

    finishStep: ({ executionId, name, completedAt, status }) =>
      run("finishStep", () =>
        db
          .prepare(
            `UPDATE steps
               SET status = ?, completed_at = ?
             WHERE execution_id = ? AND name = ?`,
          )
          .bind(status, completedAt, executionId, name)
          .run(),
      ),
  };

  return Layer.succeed(Executions, service);
};
