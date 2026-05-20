// `daily-demo` — the FlareDispatch V3 Schedule-mode run.
//
// First fully Schedule-mode-triggered run in the catalog. A Cloudflare Cron
// Trigger fires the Dispatcher's `scheduled()` handler at 14:00 UTC daily; the
// handler routes the tick to this run via `schedules[].cron` and instantiates
// a RunWorkflow with the date-stamped `idempotencyKey` as the Workflow id.
//
// What the run does:
//   1. Clones the target webapp repo @ main into a CF Sandbox container.
//   2. Installs deps (pnpm) + Playwright Chromium with system libs.
//   3. Pulls Cloudflare Access + Clerk staging credentials from the config
//      store (`staging/` prefix; see § Operator setup in the recipe README).
//   4. Runs `qa/acceptance/playwright.demo.config.ts` against the deployed
//      staging tier, with the same slowMo + video recording the local
//      `/demo-e2e` skill produces.
//   5. Uploads video.webm + summary.md + trace.zip as signed-R2 artifacts —
//      30-day TTL. The check-run summary links the three.
//
// Three deliberate departures from `cdp-acceptance`:
//
// 1. NO `bootApp`. The demo targets the *already-deployed* staging tier, not
//    a fresh container app. Skipping the boot path also skips the DAM/edge
//    Worker plumbing — staging owns those.
//
// 2. NO Cloudflare Browser Rendering / `requiresBrowser`. Playwright drives
//    its own bundled Chromium inside the container so that `recordVideo`
//    captures locally as a webm; Browser Rendering's remote CDP gives a
//    detached browser whose video stream would need a separate capture path
//    we don't want to build for the daily demo.
//
// 3. Targets a **deployed URL**, not a `localhost:<port>`. The run input
//    carries `stagingBaseUrl`; the spec reads it from
//    `process.env.STAGING_WEB_BASE` so the value is set in-process before
//    Playwright reads it.
//
// Spec: specs/04-gha-integration.md § Schedule mode,
//       specs/03-dsl.md § schedules.

import { Effect, Schema } from "effect";
import { artifact, defineRun, io, sandbox, step } from "@flare-dispatch/core";
import { loadSecrets, workspace } from "@flare-dispatch/core/primitives";

/** UTC calendar date — `YYYY-MM-DD`. The cron-window dedup key. */
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Input contract. A Schedule-mode run's cron tick carries no GitHub payload,
 * so `inputs` IS the run body — there is no PR / SHA to inherit. The defaults
 * in `schedules[].inputs` below are placeholders; an operator MUST override
 * them (either by editing this file pre-deploy or by sourcing the values from
 * `CONFIG_KV`) to point at their webapp repo and deployed staging URL.
 */
const DailyDemoInput = Schema.Struct({
  /** Epoch ms — `controller.scheduledTime`. Used in the artifact run id. */
  firedAt: Schema.Number,
  /** `"owner/name"` — the webapp repo to clone for the demo spec. */
  repo: Schema.String,
  /** Branch/ref/SHA — `git.clone` resolves a branch name to its tip. */
  ref: Schema.String,
  /** Required by `RunWorkflow` payload — same value as `ref` for branch runs. */
  sha: Schema.String,
  /** Public deployed URL the demo spec drives against. */
  stagingBaseUrl: Schema.String,
  /** Playwright slowMo override; the spec defaults to 200 if unset. */
  slowMoMs: Schema.optionalWith(Schema.Number, { default: () => 200 }),
});

/**
 * Output contract — the three signed R2 URLs the stakeholder Slack post (or
 * the check-run summary) links. `exitCode` is the Playwright runner's exit
 * code; non-zero is a failed demo but recorded as run output, not run failure
 * — the artifacts are still uploaded and worth watching.
 */
const DailyDemoOutput = Schema.Struct({
  exitCode: Schema.Number,
  videoUri: Schema.String,
  summaryUri: Schema.String,
  traceUri: Schema.String,
  runId: Schema.String,
});

/**
 * The KV keys the run reads from the FlareDispatch config store. All four
 * MUST be populated under the `staging/` prefix before the cron fires —
 * see recipes/daily-demo/README.md § Operator setup.
 */
const DEMO_SECRETS = [
  "STAGING_WEB_BASE",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "VITE_CLERK_PUBLISHABLE_KEY",
] as const;

/** Demo spec + config paths in the target repo — repo-relative. */
const DEMO_SPEC_RELATIVE = "qa/acceptance/tests/demo-onboarding-creative.spec.ts";
const DEMO_CONFIG_RELATIVE = "qa/acceptance/playwright.demo.config.ts";
/** Where the playwright.demo.config.ts writes its outputDir, repo-relative. */
const DEMO_RUNS_DIR = ".tmp/demo-runs";
/**
 * pnpm workspace filter for the QA package in the target repo. Adjust to
 * match your repo's package layout (e.g. `@your-org/qa`, `qa`, or drop the
 * `--filter` flag entirely if Playwright is installed at the repo root).
 */
const DEMO_PNPM_FILTER = "@example/qa";

export const dailyDemo = defineRun({
  name: "daily-demo",
  version: "1.0.0",

  inputs: DailyDemoInput,
  outputs: DailyDemoOutput,

  limits: {
    // Generous; the demo spec is ~8 steps with slowMo=200ms + video capture +
    // four concept generations on staging. Empirically ~3–5 min wall-time on
    // a healthy run, but the staging DAM/Worker cold-start can push it.
    maxDurationSec: 1200,
  },

  // Schedule mode binding — 14:00 UTC daily. The cron expression MUST also
  // appear in wrangler.jsonc `triggers.crons`. See specs/04-gha-integration.md
  // § Schedule mode. The dedup key is per-UTC-day so a duplicate Cron Trigger
  // delivery (or a same-day operator-triggered Worker recycle) collapses to
  // the original instance via CF Workflows' `create({ id })` no-op semantics.
  schedules: [
    {
      cron: "0 14 * * *",
      idempotencyKey: ({ firedAt }) =>
        `daily-demo:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({
        firedAt,
        // OPERATOR: replace with your webapp repo (`"owner/name"`).
        repo: "OWNER/REPO",
        ref: "main",
        sha: "main",
        // OPERATOR: replace with your deployed Pages/Worker URL. The config
        // store also holds this value (loadSecrets pulls it as env) so the
        // spec can read either source — we set the input as the canonical
        // record; loadSecrets is the override path for the operator to swap
        // envs without editing run code.
        stagingBaseUrl: "https://staging.example.com",
        slowMoMs: 200,
      }),
    },
  ],

  run: (input) =>
    Effect.gen(function* () {
      const runId = isoDate(input.firedAt);

      // 1. Acquire container, clone repo @ ref, cached pnpm install.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.ref, install: true }),
      );

      // 2. Pull the demo's credentials from the config store — Clerk staging
      //    publishable key + the CF Access service-token pair that bypasses
      //    the Access gate from outside the tailnet. INLINE, not in a `step`
      //    — see loadSecrets' header on why plaintext credentials must not
      //    be checkpointed to Workflow state.
      const secretEnv = yield* loadSecrets(DEMO_SECRETS, {
        prefix: "staging/",
        required: true,
      });

      // 3. Install Playwright's Chromium + the OS libs it dynamically links.
      //    The CF Sandbox base image is clean — neither browsers nor `xvfb`
      //    /`libnss3`/etc are present. `--with-deps` runs the OS-level apt
      //    install too; without it Playwright crashes on a missing libnss3.
      yield* step("install-browsers", () =>
        sandbox.exec({
          cwd: dir,
          container,
          command:
            `pnpm --filter ${DEMO_PNPM_FILTER} exec playwright install --with-deps chromium`,
        }),
      );

      // 4. Run the demo spec. We pass the resolved secrets + a few extra env
      //    vars the demo config reads: STAGING_WEB_BASE (resolves the target),
      //    DEMO_RUN_ID (Playwright `outputDir` segment so artifacts land at
      //    a known path), DEMO_SLOW_MO_MS (per-action throttle for the
      //    stakeholder-friendly pacing).
      //
      //    Non-zero exit code is a FAILED DEMO (stakeholder-visible UX
      //    regression) — surfaced via output.exitCode, but NOT an Effect
      //    failure. We still want the video + trace uploaded; a thrown
      //    failure would short-circuit the artifact steps.
      const exec = yield* step("run-demo", () =>
        sandbox.exec({
          cwd: dir,
          container,
          env: {
            ...secretEnv,
            // Belt-and-braces: `secretEnv` already carries STAGING_WEB_BASE
            // from KV, but if the operator omitted it the input value wins.
            STAGING_WEB_BASE: secretEnv.STAGING_WEB_BASE ?? input.stagingBaseUrl,
            DEMO_RUN_ID: runId,
            DEMO_SLOW_MO_MS: String(input.slowMoMs),
          },
          command: `pnpm --filter ${DEMO_PNPM_FILTER} exec playwright test --config ${DEMO_CONFIG_RELATIVE}`,
        }),
      );

      // 5. Upload the three artifacts. The demo config writes them under
      //    `${dir}/${DEMO_RUNS_DIR}/${runId}/`; we upload the whole run
      //    directory so the operator gets the trace.zip + report.json bundle
      //    alongside the video + summary. Signed-URL TTL of 30 days matches
      //    `cdp-acceptance` — long enough for an investor to share, short
      //    enough that an old demo URL stops leaking infinitely.
      const runRoot = `${dir}/${DEMO_RUNS_DIR}/${runId}`;
      const videoUri = yield* step("upload-video", () =>
        artifact.upload({
          name: "demo-video",
          // Glob ensures we find the Playwright-emitted video.webm regardless
          // of the per-project / per-retry subdir name.
          path: `${runRoot}/`,
          container,
          signedUrlTTL: "30 days",
        }),
      );
      const summaryUri = yield* step("upload-summary", () =>
        artifact.upload({
          name: "demo-summary",
          path: `${runRoot}/summary.md`,
          container,
          signedUrlTTL: "30 days",
        }),
      );
      const traceUri = yield* step("upload-trace", () =>
        artifact.upload({
          name: "demo-trace",
          path: `${runRoot}/`,
          container,
          signedUrlTTL: "30 days",
        }),
      );

      yield* io.log(
        "info",
        `daily-demo runId=${runId} exit=${exec.exitCode}`,
      );

      return {
        exitCode: exec.exitCode,
        videoUri,
        summaryUri,
        traceUri,
        runId,
      };
    }),
});
