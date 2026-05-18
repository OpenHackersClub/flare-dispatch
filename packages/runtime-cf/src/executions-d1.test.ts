// Integration tests for D1ExecutionsLive — the live `executions` capability.
//
// Drives the real D1 binding via Miniflare (see test-support.ts). Asserts the
// `executions` + `steps` rows the service writes, and pins the per-step D1
// write count (plan § 6 flags D1 hot-path writes — PR4 keeps it bounded).

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executions } from "@flare-dispatch/core";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { countRows, makeTestBindings, type TestBindings } from "./test-support";

const EXECUTION_ID = "01TEST00000000000000000001";
const CTX: ExecutionContext = {
  repo: "owner/name",
  ref: "refs/heads/main",
  sha: "abc123",
  input: { command: "pnpm test" },
};

describe("D1ExecutionsLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("writes one executions row spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 1000,
        });
        yield* executions.finishExecution({
          id: EXECUTION_ID,
          completedAt: 2000,
          status: "success",
        });
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one executions row — start INSERTs, finish UPDATEs the same row.
    expect(await countRows(bindings.db, "executions")).toBe(1);

    const row = await bindings.db
      .prepare(
        `SELECT id, run, repo, ref, sha, status, started_at, completed_at, input_json
           FROM executions WHERE id = ?`,
      )
      .bind(EXECUTION_ID)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      id: EXECUTION_ID,
      run: "offload-test",
      repo: "owner/name",
      ref: "refs/heads/main",
      sha: "abc123",
      status: "success",
      started_at: 1000,
      completed_at: 2000,
    });
    expect(JSON.parse(String(row?.input_json))).toEqual({ command: "pnpm test" });
  });

  it("writes one steps row per step, each spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const stepNames = ["checkout", "exec", "upload-log"];

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        // One start + one finish per step — the inline/CF StepRunner contract.
        for (const name of stepNames) {
          yield* executions.startStep({
            executionId: EXECUTION_ID,
            name,
            startedAt: 10,
          });
          yield* executions.finishStep({
            executionId: EXECUTION_ID,
            name,
            completedAt: 20,
            status: "success",
          });
        }
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one steps row per step — `finishStep` UPDATEs, never INSERTs.
    expect(await countRows(bindings.db, "steps")).toBe(stepNames.length);

    const rows = await bindings.db
      .prepare(
        `SELECT name, status, started_at, completed_at
           FROM steps WHERE execution_id = ? ORDER BY started_at, name`,
      )
      .bind(EXECUTION_ID)
      .all<{ name: string; status: string }>();

    expect(rows.results.map((r) => r.name).sort()).toEqual(
      [...stepNames].sort(),
    );
    expect(rows.results.every((r) => r.status === "success")).toBe(true);
  });

  it("records a step failure with its error tag", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 10,
        });
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
        });
      }).pipe(Effect.provide(layer)),
    );

    const step = await bindings.db
      .prepare(`SELECT status FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(EXECUTION_ID, "exec")
      .first<{ status: string }>();
    expect(step?.status).toBe("failure");
  });
});
