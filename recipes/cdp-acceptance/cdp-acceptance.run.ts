// Recipe: CDP acceptance tests — the `cdp-acceptance` Run
//
// The typed Run that ./ci.yml dispatches. Boots the app under test in a
// detached container, attaches Browser Rendering over the Chrome DevTools
// Protocol, runs the acceptance suite, and uploads screenshots + a trace as
// artifacts (see ./README.md — those can be attached to the PR).
//
// This recipe rides on two primitives — `workspace` (acquire + clone +
// cached install) and `bootApp` (detached run + wait-for-port) — so the file
// carries only the CDP-specific logic. See specs/03-dsl.md § Primitives.
//
// This recipe is the minimal illustration of the run shape. The shipped run is
// `runs/cdp-acceptance.ts` — it additionally injects credentials from the
// config store via the `loadSecrets` primitive (see its header). Recipe scope:
// specs/02-runs.md § 4. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, browser, artifact, io } from "@flare-dispatch/core";
import { workspace, bootApp } from "@flare-dispatch/core/primitives";

const Input = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  appBootCommand: Schema.String, // e.g. "pnpm dev"
  appPort: Schema.Number, // e.g. 4173
  testCommand: Schema.String, // e.g. "pnpm test:acceptance"
});

const Output = Schema.Struct({
  exitCode: Schema.Number,
  reportUri: Schema.String, // HTML report
  screenshotsUri: Schema.String, // screenshots + trace — attachable to the PR
});

export const cdpAcceptance = defineRun({
  name: "cdp-acceptance",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 1800, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      // Acquire a container, clone the target SHA, and install dependencies
      // from the R2-backed cache — the whole checkout dance is one primitive.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );

      // Boot the app in a detached container and block until its port opens.
      yield* step("boot-app", () =>
        bootApp({
          container,
          dir,
          command: input.appBootCommand,
          port: input.appPort,
          timeoutSec: 120,
        }),
      );

      // Attach Browser Rendering over CDP and run the acceptance suite. The
      // suite drives the app and writes screenshots/traces under ./artifacts.
      const session = yield* step("attach-cdp", () =>
        browser.newCDPSession({ targetUrl: `http://localhost:${input.appPort}` }),
      );
      const exec = yield* step("run-tests", () =>
        sandbox.exec({
          cwd: dir,
          container,
          env: { CDP_WS_URL: session.wsEndpoint },
          command: input.testCommand,
        }),
      );

      // Upload the report and the screenshots/trace bundle. Both come back as
      // signed R2 URLs in the check-run summary; a developer can drop the
      // screenshots or the demo recording straight into the PR.
      const reportUri = yield* step("upload-report", () =>
        artifact.upload({
          name: "acceptance-report",
          path: `${dir}/playwright-report/`,
          container,
          signedUrlTTL: "30 days",
        }),
      );
      const screenshotsUri = yield* step("upload-screenshots", () =>
        artifact.upload({
          name: "screenshots",
          path: `${dir}/artifacts/`,
          container,
          signedUrlTTL: "30 days",
        }),
      );

      yield* io.log("info", `cdp-acceptance exited ${exec.exitCode}`);
      return { exitCode: exec.exitCode, reportUri, screenshotsUri };
    }),
});
