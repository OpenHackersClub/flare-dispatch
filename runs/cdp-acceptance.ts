// `cdp-acceptance` — the FlareDispatch V2 browser-acceptance run.
//
// Clones a repo, installs dependencies from the R2 cache, boots the app under
// test in a detached container, attaches Cloudflare Browser Rendering over the
// Chrome DevTools Protocol, runs the acceptance suite, and uploads the HTML
// report + a screenshots/trace bundle as artifacts. This is the run the
// roadmap's V2 exit criterion exercises (specs/pm/plan.md § roadmap).
//
// Contract — inputs/outputs per specs/02-runs.md § 4. Body shape per the
// recipe in recipes/cdp-acceptance/. The run rides on three primitives —
// `workspace` (acquire + clone + cached install), `loadSecrets` (config-store
// credential injection), and `bootApp` (detached run + wait-for-port) — so the
// body carries only the CDP-specific orchestration.
//
// --- Three design decisions, documented inline ------------------------------
//
// 1. Secrets are injected via `loadSecrets`, not the dispatch body.
//    The migration target (numu's acceptance-cf job) needs `CLERK_*` /
//    `CLOUDFLARE_*` credentials to boot its dev servers. Rather than thread
//    them through GHA repo secrets and the dispatch payload, the operator
//    stores them in the FlareDispatch config store (KV); the run names the
//    keys in `inputs.secrets` and `loadSecrets` resolves them into the env
//    handed to BOTH the app boot and the test command. A key that is unset is
//    omitted + logged at `warn` — never a hard failure (see load-secrets.ts).
//
// 2. No `finalize` step — same boundary as `offload-test`.
//    The D1 `executions`-row status write and the GitHub check-run callback
//    are `RunWorkflow` plumbing, not run logic. The run records only its
//    steps; the Workflow records the execution. See runs/offload-test.ts
//    header note 1.
//
// 3. CDP target reachability is a deploy-time concern.
//    `attach-cdp` hands the test command a `CDP_WS_URL` — the container's
//    Playwright process dials Cloudflare Browser Rendering directly (the
//    `/connect` WS endpoint, see @flare-dispatch/runtime-cf browser-cf.ts).
//    Whether the *browser* can in turn reach the app under test is a
//    networking property of the deploy (the app may need a publicly exposed
//    port rather than container `localhost`); the run keeps the spec'd
//    `targetUrl` shape and leaves that wiring to the runtime.
//
// Spec: specs/02-runs.md § 4, specs/03-dsl.md § browser + § Primitives,
//       specs/pm/plan.md § V1 / V2 plan — PR9.

import { Effect, Schema } from "effect";
import { artifact, browser, defineRun, io, sandbox, step } from "@flare-dispatch/core";
import { bootApp, loadSecrets, workspace } from "@flare-dispatch/core/primitives";

/** Input contract — specs/02-runs.md § 4. */
const CdpAcceptanceInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  appBootCommand: Schema.String, // e.g. "pnpm dev" — may be multi-stage
  appPort: Schema.Number, // e.g. 4173
  testCommand: Schema.String, // e.g. "pnpm test:acceptance"
  /**
   * Config-store keys whose values are injected — as env vars of the same
   * name — into the app boot and the test command. Empty when the suite needs
   * no credentials. See `loadSecrets`.
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Prefix prepended to each `secrets` key for the config lookup. */
  secretPrefix: Schema.optional(Schema.String),
});

/** Output contract — specs/02-runs.md § 4. */
const CdpAcceptanceOutput = Schema.Struct({
  exitCode: Schema.Number,
  reportUri: Schema.String, // signed R2 URL to the HTML report
  screenshotsUri: Schema.String, // signed R2 URL to the screenshots + trace bundle
});

/** Wait-for-port ceiling for the app boot, in seconds. */
const APP_BOOT_TIMEOUT_SEC = 120;

export const cdpAcceptance = defineRun({
  name: "cdp-acceptance",
  version: "1.0.0",

  inputs: CdpAcceptanceInput,
  outputs: CdpAcceptanceOutput,

  limits: {
    // Wall-time ceiling — specs/02-runs.md § 4. `requiresBrowser` selects a
    // runtime that wires the live Browser Rendering Layer.
    maxDurationSec: 1800,
    requiresBrowser: true,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — acquire a container, clone the SHA, install deps from the
      // R2-backed cache. The whole checkout dance is one primitive.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );

      // load-secrets — resolve the named credentials from the config store
      // into the env injected below. A checkpointed step so replay is stable.
      const secretEnv = yield* step("load-secrets", () =>
        loadSecrets(input.secrets, { prefix: input.secretPrefix }),
      );

      // boot-app — start the app in a detached container with the injected
      // secrets and block until its port opens.
      yield* step("boot-app", () =>
        bootApp({
          container,
          dir,
          command: input.appBootCommand,
          port: input.appPort,
          timeoutSec: APP_BOOT_TIMEOUT_SEC,
          env: secretEnv,
        }),
      );

      // attach-cdp — open a Browser Rendering CDP session. `wsEndpoint` is the
      // URL the test command's Playwright process connects over.
      const session = yield* step("attach-cdp", () =>
        browser.newCDPSession({
          targetUrl: `http://localhost:${input.appPort}`,
        }),
      );

      // run-tests — run the acceptance suite. A non-zero exit code is a NORMAL
      // ExecResult (a failing test), surfaced to the output below — never an
      // Effect failure. The suite writes screenshots/traces under ./artifacts.
      const exec = yield* step("run-tests", () =>
        sandbox.exec({
          cwd: dir,
          container,
          env: { ...secretEnv, CDP_WS_URL: session.wsEndpoint },
          command: input.testCommand,
        }),
      );

      // upload-report / upload-screenshots — promote both bundles to signed R2
      // URLs surfaced in the check-run summary.
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
