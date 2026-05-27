// Run-level unit tests for the `cdp-acceptance` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram` + the Browser fake) — no CF, no
// Docker, no browser, no network. The acceptance cases mirror PR3's shape for
// `offload-test`, adapted to the browser-acceptance run:
//
//   (a) green   — fake test command exits 0 → output `.exitCode === 0`, the
//                  seven run-body steps each recorded once, the CDP session
//                  opened against the app port.
//   (b) red     — fake test command exits 1 → the run Effect *succeeds*
//                  (a non-zero exit is a normal ExecResult), `.exitCode === 1`.
//   (c) timeout — the test command raises ExecTimeout → the run Effect *fails*
//                  with the `ExecTimeout` tag, re-failed unchanged.
//   (d) secrets — config-store secrets are resolved by `loadSecrets` and
//                  injected — as same-named env vars — into BOTH the app boot
//                  and the test command, the latter alongside `CDP_WS_URL`.
//
// Spec: specs/pm/plan.md § V1 / V2 plan — PR9, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { cdpAcceptance } from "./cdp-acceptance";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  appBootCommand: "pnpm dev",
  appPort: 4173,
  testCommand: "pnpm test:acceptance",
  secrets: [] as readonly string[],
} as const;

describe("cdp-acceptance", () => {
  it.effect("green path — test command exits 0, seven steps, CDP attached", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test:acceptance": { exitCode: 0 } },
      browser: { wsEndpoint: "wss://test-cdp/abc" },
    });

    return Effect.gen(function* () {
      const result = yield* cdpAcceptance.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(result.reportUri.length).toBeGreaterThan(0);
      expect(result.screenshotsUri.length).toBeGreaterThan(0);

      // checkout → boot-app → expose-app → attach-cdp → run-tests →
      // upload-report → upload-screenshots, each recorded once, all successful.
      // `loadSecrets` is called inline (not a step) so credentials never hit a
      // checkpoint.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "boot-app",
        "expose-app",
        "attach-cdp",
        "run-tests",
        "upload-report",
        "upload-screenshots",
      ]);
      expect(
        handles.executions.steps.every((s) => s.status === "success"),
      ).toBe(true);

      // The app port was exposed to get a publicly-reachable URL.
      expect(handles.sandbox.exposed).toEqual([{ port: 4173, name: undefined }]);

      // The CDP session was opened against the *exposed* URL, not `localhost`
      // (the cloud browser cannot reach the container's localhost).
      expect(handles.browser.cdpSessions).toEqual([
        { targetUrl: "https://4173-fake-sandbox.example.com" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "red path — test command exits 1, output reports exitCode 1, Effect succeeds",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test:acceptance": { exitCode: 1, stderr: "1 failing spec" },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(cdpAcceptance.run(baseInput));

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.exitCode).toBe(1);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "timeout — the test command raises ExecTimeout, the run re-fails with the tag",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test:acceptance": { fail: "ExecTimeout", timeoutSec: 1800 },
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(cdpAcceptance.run(baseInput));

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
    "secrets — config-store values are injected into the boot + test env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test:acceptance": { exitCode: 0 } },
        browser: { wsEndpoint: "wss://test-cdp/abc" },
        config: { "secret/CLERK_SECRET_KEY": "sk_live_x" },
      });
      const input = {
        ...baseInput,
        secrets: ["CLERK_SECRET_KEY"],
        secretPrefix: "secret/",
      };

      return Effect.gen(function* () {
        yield* cdpAcceptance.run(input);

        // The app boot gets the resolved secret.
        const boot = handles.sandbox.execs.find((e) => e.command === "pnpm dev");
        expect(boot?.env).toEqual({ CLERK_SECRET_KEY: "sk_live_x" });

        // The test command gets the secret, the CDP endpoint, and the
        // publicly-reachable target URL the suite navigates to.
        const test = handles.sandbox.execs.find(
          (e) => e.command === "pnpm test:acceptance",
        );
        expect(test?.env).toEqual({
          CLERK_SECRET_KEY: "sk_live_x",
          CDP_WS_URL: "wss://test-cdp/abc",
          CDP_TARGET_URL: "https://4173-fake-sandbox.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails the run with SecretsMissing",
    () => {
      // No `config` seed — the named secret resolves to nothing. `loadSecrets`
      // runs with `required: true`, so the run fails fast instead of booting
      // the app without the credential.
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test:acceptance": { exitCode: 0 } },
        browser: { wsEndpoint: "wss://test-cdp/abc" },
      });
      const input = { ...baseInput, secrets: ["CLERK_SECRET_KEY"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(cdpAcceptance.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");
      }).pipe(Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// Per specs/pm/plan.md § 6 — the run body must not introduce non-determinism;
// replay-sensitive values come from checkpointed step results (or `io`).
describe("cdp-acceptance source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./cdp-acceptance.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
