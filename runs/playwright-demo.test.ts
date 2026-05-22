// Run-level unit tests for the `playwright-demo` run.
//
// Drives the run Effect against the in-memory test runtime — no CF, no
// Docker, no browser, no network. The acceptance cases mirror the
// `offload-test` + `cdp-acceptance` shape, adapted to the run's
// "checkout → loadSecrets → exec → upload-video → upload-log" body:
//
//   (a) green   — fake spec exits 0 → output `.exitCode === 0`, four
//                  step records (loadSecrets is inline, not a step), the
//                  artifact bundle + log both uploaded.
//   (b) red     — fake spec exits 1 → the run Effect *succeeds*
//                  (non-zero exit is a normal ExecResult), `.exitCode
//                  === 1`.
//   (c) timeout — the spec raises ExecTimeout → the run Effect *fails*
//                  with the `ExecTimeout` tag, re-failed unchanged.
//   (d) secrets — config-store secrets are resolved by `loadSecrets`
//                  and injected — as same-named env vars — into the
//                  test command, alongside the caller-provided `env`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { playwrightDemo } from "./playwright-demo";

const PLAYWRIGHT_COMMAND =
  "pnpm --filter @numu/qa exec playwright test --config qa/acceptance/playwright.demo.config.ts";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  command: PLAYWRIGHT_COMMAND,
  artifactPath: ".tmp/demo-runs",
  secrets: [] as readonly string[],
} as const;

describe("playwright-demo", () => {
  it.effect(
    "green path — spec exits 0, four steps, bundle + log uploaded",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [PLAYWRIGHT_COMMAND]: { exitCode: 0 } },
      });

      return Effect.gen(function* () {
        const result = yield* playwrightDemo.run(baseInput);

        expect(result.exitCode).toBe(0);
        expect(result.videoUri.length).toBeGreaterThan(0);
        expect(result.logUri.length).toBeGreaterThan(0);

        // checkout → run-playwright → upload-video → upload-log. Four
        // entries — loadSecrets is inline, no checkpoint.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "run-playwright",
          "upload-video",
          "upload-log",
        ]);
        expect(
          handles.executions.steps.every((s) => s.status === "success"),
        ).toBe(true);

        // Two artifact uploads — the bundle directory and the captured log.
        expect(handles.artifact.uploads).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "red path — spec exits 1, output reports exitCode 1, Effect succeeds",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          [PLAYWRIGHT_COMMAND]: { exitCode: 1, stderr: "1 failing spec" },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(playwrightDemo.run(baseInput));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.exitCode).toBe(1);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "timeout — spec raises ExecTimeout, the run re-fails with the same tag",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          [PLAYWRIGHT_COMMAND]: { fail: "ExecTimeout", timeoutSec: 1200 },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(playwrightDemo.run(baseInput));

        expect(Exit.isFailure(exit)).toBe(true);
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
    "secrets — loadSecrets resolves prefixed keys into the exec env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [PLAYWRIGHT_COMMAND]: { exitCode: 0 } },
        config: {
          "staging/CF_ACCESS_CLIENT_ID": "id-123",
          "staging/CF_ACCESS_CLIENT_SECRET": "sk-456",
          "staging/STAGING_WEB_BASE": "https://example.pages.dev",
        },
      });

      return Effect.gen(function* () {
        const result = yield* playwrightDemo.run({
          ...baseInput,
          env: { DEMO_RUN_ID: "ci-2026-05-22" },
          secrets: [
            "CF_ACCESS_CLIENT_ID",
            "CF_ACCESS_CLIENT_SECRET",
            "STAGING_WEB_BASE",
          ],
          secretPrefix: "staging/",
        });

        expect(result.exitCode).toBe(0);

        // The exec recorded the merged env — resolved secrets surfaced
        // as bare env-var names (prefix stripped), plus the caller's
        // non-credential knob.
        const execCall = handles.sandbox.execs.at(-1);
        expect(execCall?.env?.CF_ACCESS_CLIENT_ID).toBe("id-123");
        expect(execCall?.env?.CF_ACCESS_CLIENT_SECRET).toBe("sk-456");
        expect(execCall?.env?.STAGING_WEB_BASE).toBe(
          "https://example.pages.dev",
        );
        expect(execCall?.env?.DEMO_RUN_ID).toBe("ci-2026-05-22");
      }).pipe(Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("playwright-demo source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./playwright-demo.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
