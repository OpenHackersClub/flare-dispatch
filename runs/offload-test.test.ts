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
//   (d) secrets     — config-store secrets are resolved by `loadSecrets` and
//                      injected into the exec env (per-dispatch `env` wins on
//                      a key collision); a named-but-unset key fails the run
//                      with `SecretsMissing` before the exec
//   (e) install     — `install: true` runs the R2-cached dependency install
//                      inside the checkout step; the `image` override reaches
//                      the container acquire
//
// Plus a determinism guard: the run body must not call `Date.now()` /
// `crypto.randomUUID()` directly — non-determinism flows only through `io`,
// and `durationMs` is sourced from the checkpointed `exec` step result so it
// is stable across Workflow replays (specs/pm/plan.md § 6 "Run replay
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
  secrets: [] as readonly string[],
  install: false,
} as const;

describe("offload-test", () => {
  it.effect("green path — exec exits 0, output reports exitCode 0", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);

      expect(result.exitCode).toBe(0);
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

  it.effect(
    "durationMs is the checkpointed exec ExecResult's durationMs",
    () => {
      // The run reports `result.durationMs` straight from the `exec` step's
      // `ExecResult` — the replay-safe source, since only step results are
      // memoized across Workflow replays. The run must not recompute it from
      // wall-clock reads. Pin a distinctive `durationMs` on the canned exec
      // result and assert the run output carries exactly that value.
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0, durationMs: 4242 } },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(baseInput);
        expect(result.durationMs).toBe(4242);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "install — runs the cached dependency install in the checkout, image override reaches acquire",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, install: true, image: "custom/image:1" };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // The container acquire honours the `image` override (previously the
        // input was declared but never threaded).
        expect(handles.sandbox.acquired[0]).toEqual({ image: "custom/image:1" });

        // `installCached` detected pnpm from the lockfile probe and — the test
        // Cache fake always misses — ran the real install before the command.
        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");
        expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
          commands.indexOf("pnpm test"),
        );

        // Still exactly the three run steps — the install lives inside
        // `checkout`, not a fourth step.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — config-store values are injected into the exec env, per-dispatch env wins",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "secret/SOME_API_KEY": "key_from_store",
          "secret/SOME_BASE_URL": "https://store.example.com",
        },
      });
      const input = {
        ...baseInput,
        secrets: ["SOME_API_KEY", "SOME_BASE_URL"],
        secretPrefix: "secret/",
        // Collides with the config-store key — the per-dispatch value (the
        // more specific source) must win.
        env: { SOME_BASE_URL: "https://dispatch.example.com" },
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find(
          (e) => e.command === "pnpm test",
        );
        expect(exec?.env).toEqual({
          SOME_API_KEY: "key_from_store",
          SOME_BASE_URL: "https://dispatch.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails the run with SecretsMissing before the exec",
    () => {
      // No `config` seed — the named secret resolves to nothing. `loadSecrets`
      // runs with `required: true`, so the run fails fast instead of executing
      // the command without the credential.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, secrets: ["SOME_API_KEY"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");

        // Fail-fast: the command never ran.
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// A grep guard per specs/pm/plan.md § 6 — the run body must not introduce
// non-determinism; replay-sensitive values come from checkpointed step results
// (or `io`), so Workflow checkpoint replay is consistent.
describe("offload-test source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
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
