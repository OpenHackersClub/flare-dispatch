// Recipe: CDP acceptance tests — the `cdp-acceptance` Run
//
// The typed Run that ./ci.yml dispatches. Boots the app under test in a
// detached container, attaches Browser Rendering over the Chrome DevTools
// Protocol, runs the acceptance suite, and uploads screenshots + a trace as
// artifacts (see ./README.md — those can be attached to the PR).
//
// This is the shipped `cdp-acceptance` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 4. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, browser, artifact, io } from "@flare-dispatch/core";

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
      const container = yield* sandbox.acquire({});

      const dir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha, container }),
      );

      yield* step("install", () =>
        sandbox.exec({ cwd: dir, container, command: "pnpm install --frozen-lockfile" }),
      );

      // Boot the app in detached mode and wait for its port to open.
      const app = yield* step("boot-app", () =>
        sandbox.runDetached({ cwd: dir, container, command: input.appBootCommand }),
      );
      yield* step("wait-ready", () =>
        sandbox.waitForPort({ handle: app, port: input.appPort, timeoutSec: 120 }),
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
