// Run-level unit tests for the `offload-test` run.
//
// These exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram`) — no CF, no Docker, no network.
// The three acceptance cases from specs/pm/plan.md § PR3:
//
//   (a) green path  — fake `pnpm test` exits 0  → output `.exitCode === 0`
//   (b) red path    — fake `pnpm test` exits 1  → output `.exitCode === 1`,
//                      the run Effect *succeeds* (a non-zero exit is a normal
//                      ExecResult, never an Effect failure — specs/03-dsl.md
//                      § sandbox)
//   (c) timeout     — fake `exec` raises ExecTimeout → the run Effect *fails*
//                      with the `ExecTimeout` tag, re-failed unchanged
//
// Plus a determinism guard: the run body must take its timestamps from
// `io.now`, never `Date.now()` directly (specs/pm/plan.md § 6 "Run replay
// determinism").
//
// Spec: specs/pm/plan.md § PR3, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { offloadTest } from "./offload-test";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: "pnpm test",
} as const;

describe("offload-test", () => {
  it.effect("green path — exec exits 0, output reports exitCode 0", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri.length).toBeGreaterThan(0);

      // checkout → exec → upload-log, each recorded once, all successful.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(
        handles.executions.steps.every((s) => s.status === "success"),
      ).toBe(true);
      expect(handles.sandbox.clones).toHaveLength(1);
      expect(handles.sandbox.clones[0]).toEqual({
        repo: "owner/name",
        sha: "abc123",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "red path — exec exits 1, output reports exitCode 1 and the Effect succeeds",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test": { exitCode: 1, stderr: "1 failing" },
        },
      });

      return Effect.gen(function* () {
        // The run Effect must *succeed* — a failing test is a normal result,
        // surfaced as `exitCode`, not an Effect failure.
        const exit = yield* Effect.exit(offloadTest.run(baseInput));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.exitCode).toBe(1);
        }

        // All three steps still recorded as successful — a non-zero exit does
        // not fail the `exec` step.
        expect(
          handles.executions.steps.every((s) => s.status === "success"),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "timeout — exec raises ExecTimeout, the run re-fails with the same tag",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test": { fail: "ExecTimeout", timeoutSec: 600 },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(baseInput));

        expect(Exit.isFailure(exit)).toBe(true);
        // The failure is the `ExecTimeout` tag, not swallowed, not remapped.
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("ExecTimeout");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("durationMs is sourced from io.now, not Date.now()", () => {
    // The IO fake's clock advances by `tickMs` per `io.now` call. The run
    // brackets `exec` with two `io.now` reads, so `durationMs` is a multiple
    // of `tickMs` — a value `Date.now()` could never produce. This proves the
    // run threads non-determinism through `io`, the replay-determinism rule.
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      io: { startMs: 1_000, tickMs: 250 },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);
      expect(result.durationMs % 250).toBe(0);
      expect(result.durationMs).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// A grep guard per specs/pm/plan.md § 6 — non-determinism must flow through
// `io`, so Workflow checkpoint replay is consistent.
describe("offload-test source determinism", () => {
  it.effect("the run body uses io.now, never Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./offload-test.ts", import.meta.url)),
        "utf8",
      );
      // Strip line comments so a mention in a comment never trips the guard.
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
