// `playwright-demo` — record a Playwright walkthrough of a deployed surface.
//
// Targets a hosted environment (preview / staging / prod) and runs a
// Playwright spec that captures a narrated video.webm + trace.zip + JSON
// report. No app boot — the site is already live; the test connects out
// over HTTPS (the spec is responsible for any auth header injection,
// e.g. Cloudflare Access service-token pairs read out of the env). After
// the test finishes, the run uploads the configured artifacts directory
// as a single signed R2 URL so a reviewer can pull video.webm directly
// without scrubbing through the step log.
//
// Sits between `offload-test` (clone-and-run; no artifact upload beyond
// the step log) and `product-demo` (AI-driven, rrweb-recorded, requires
// the bundled `demo-agent` image). The pragmatic middle: today's
// consumers already author Playwright specs with `video: "on"`, so a run
// that just executes them and surfaces the resulting media bundle is the
// shortest path from "I have a demo spec" to "stakeholders can click a
// URL". Use `product-demo` when prose-driven LLM walkthroughs are
// preferred; use `playwright-demo` when a hand-authored spec is the
// source of truth.
//
// --- Three design decisions, documented inline ------------------------------
//
// 1. No app boot, no CDP.
//    `cdp-acceptance` boots a server in-container and attaches Browser
//    Rendering over CDP because its target is a fresh build of the repo.
//    `playwright-demo` runs against a DEPLOYED URL, so neither the boot
//    nor the CDP attach is wanted — Playwright launches its own bundled
//    Chromium inside the container and connects out to the deployed
//    surface directly. `requiresBrowser: false` accordingly: no Browser
//    Rendering slot is reserved.
//
// 2. Secrets via `loadSecrets`, called INLINE (not in a `step`).
//    Same constraint as `cdp-acceptance` (see its header note 1). The
//    typical caller passes the staging-tier secrets the local
//    `/demo-e2e`-style skill needs — Cloudflare Access service-token
//    pair, Clerk publishable + secret keys, the deployed base URL —
//    namespaced under `staging/` (or whichever prefix the operator
//    chose). Plaintext must not land in the Workflow checkpoint, so the
//    primitive is invoked inline.
//
// 3. `artifactPath` is a directory, not a glob.
//    `artifact.upload` tars directories to .tar.zst and hands back one
//    signed URL. Globbing for `**/video.webm` adds plumbing for no gain:
//    reviewers want the whole `playwright-report/` or `.tmp/demo-runs/`
//    tree (video + trace + JSON report + screenshots) in one bundle, not
//    just the .webm. The caller points `artifactPath` at the spec's
//    `outputDir`; the run uploads the whole tree.
//
// Spec: specs/02-runs.md § 1 (input/output framing), specs/03-dsl.md §
//       Top-level shape + § sandbox + § artifact + § Primitives.

import { Effect, Schema } from "effect";
import { artifact, defineRun, io, sandbox, step } from "@flare-dispatch/core";
import { loadSecrets, workspace } from "@flare-dispatch/core/primitives";

/** Input contract — mirrors `offload-test` + `cdp-acceptance`. */
const PlaywrightDemoInput = Schema.Struct({
  repo: Schema.String, // "owner/name"
  sha: Schema.String,
  /**
   * The shell command that runs the Playwright spec. Single string so
   * the caller can chain its own `playwright install --with-deps
   * chromium` ahead of the test invocation — the run does NOT install
   * Playwright browsers for the caller, because browser-install needs
   * vary per spec (chromium-only vs all-browsers, --with-deps or not).
   */
  command: Schema.String,
  /**
   * Directory (relative to the repo root) the run tars + uploads after
   * the command exits. Typically the Playwright `outputDir` — e.g.
   * `.tmp/demo-runs` or `playwright-report`. The path must exist when
   * the command finishes; missing-directory failures surface as
   * `ArtifactUploadFailed`.
   */
  artifactPath: Schema.String,
  /**
   * Additional env vars injected alongside the resolved secrets. Use
   * for non-credential knobs the spec reads (e.g. `DEMO_RUN_ID`,
   * `DEMO_SLOW_MO_MS`). Credentials go through `secrets` + the
   * config store, not this field, so they don't end up in the
   * dispatch payload.
   */
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  /**
   * Config-store keys whose values are injected — as env vars of the
   * same name — into the test command. Empty when the spec needs no
   * credentials. Resolved via `loadSecrets` (see header note 2).
   */
  secrets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** Prefix prepended to each `secrets` key for the config lookup. */
  secretPrefix: Schema.optional(Schema.String),
  /** Wall-clock ceiling for the test command. Default 1200s. */
  timeoutSec: Schema.optional(Schema.Number),
});

/** Output contract. `videoUri` is the directory tarball; the caller's
 * spec is what produced the video.webm inside it. */
const PlaywrightDemoOutput = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  videoUri: Schema.String, // signed R2 URL to the `artifactPath` tarball
  logUri: Schema.String, // signed R2 URL to the captured stdout/stderr
});

/** Default `exec` timeout when the caller omits `timeoutSec`. */
const DEFAULT_TIMEOUT_SEC = 1200;

/**
 * Headroom added to the `exec` timeout to derive the Workflow STEP timeout.
 *
 * The `run-playwright` step wraps a `sandbox.exec` that legitimately runs for
 * many minutes — `playwright install --with-deps chromium` plus a slowMo'd,
 * video-recording walkthrough. CF Workflows caps every `step.do` at a 10-minute
 * default unless a `timeout` is set (see runtime-cf `buildStepConfig`), so
 * without an explicit step timeout the platform hard-kills the exec at 600s with
 * `WorkflowTimeoutError`, retries it to exhaustion, and the run never produces
 * output. We give the STEP a timeout slightly longer than the EXEC's so the
 * sandbox's own deadline fires first (yielding a clean `ExecTimeout`/`ExecResult`
 * the run can report) instead of an opaque platform kill. Capped below
 * `maxDurationSec` so the step can never outlive the run's wall-clock ceiling.
 */
const STEP_TIMEOUT_HEADROOM_SEC = 120;

/** Run wall-clock ceiling — also the upper bound on any single step's timeout. */
const MAX_DURATION_SEC = 1800;

export const playwrightDemo = defineRun({
  name: "playwright-demo",
  version: "1.0.0",

  // Routes to the chromium-baked sandbox image (RUNS_SANDBOX_BROWSER). Unlike
  // `cdp-acceptance` / `product-demo` (which dial CF Browser Rendering over CDP
  // and stay on the lean image), this run launches Playwright's OWN bundled
  // chromium INSIDE the container — so it needs the browser pre-baked. This is
  // why it's `sandboxImage: "browser"` yet `requiresBrowser` is absent (false):
  // no CF Browser Rendering slot, but a real in-image browser. See define-run.ts
  // § SandboxImage and the routing in apps/dispatcher/src/workflow.ts.
  sandboxImage: "browser",

  inputs: PlaywrightDemoInput,
  outputs: PlaywrightDemoOutput,

  limits: {
    // 30-min wall-time ceiling — the typical demo spec runs in 60-180s
    // but `pnpm install` + `playwright install --with-deps chromium`
    // dominate on a cold container, and a flaky deploy can stretch the
    // first navigation. No Browser Rendering slot is reserved — see
    // header note 1.
    maxDurationSec: MAX_DURATION_SEC,
  },

  run: (input) =>
    Effect.gen(function* () {
      // checkout — acquire a container, clone the SHA, run the cached
      // pnpm install. The whole checkout dance is one primitive.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );

      // load-secrets — resolve named credentials from the config store
      // into the env injected into the test command. Inline, not in a
      // `step` (see header note 2). `required: true` fails the run with
      // `SecretsMissing` rather than running a credential-less demo.
      const secretEnv = yield* loadSecrets(input.secrets, {
        prefix: input.secretPrefix,
        required: true,
      });

      // run-playwright — execute the test command. A non-zero exit is a
      // NORMAL ExecResult (a failing spec), surfaced to the output below
      // — never an Effect failure. The injected env merges the resolved
      // secrets with the caller-provided `env` (non-credential knobs
      // like `DEMO_RUN_ID`); secrets win on key collision so a typo in
      // `env` cannot shadow the real credential.
      //
      // The step carries an EXPLICIT timeout (see `STEP_TIMEOUT_HEADROOM_SEC`)
      // so the multi-minute command isn't hard-killed at CF's 10-minute step
      // default. `retries: 0` because a demo that fails or times out should
      // report that once — not be re-run five times over an hour (which is
      // exactly what the bare default produced).
      const execTimeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      const stepTimeoutSec = Math.min(
        execTimeoutSec + STEP_TIMEOUT_HEADROOM_SEC,
        MAX_DURATION_SEC,
      );
      const exec = yield* step(
        "run-playwright",
        () =>
          sandbox.exec({
            cwd: dir,
            container,
            env: { ...(input.env ?? {}), ...secretEnv },
            command: input.command,
            timeoutSec: execTimeoutSec,
          }),
        { timeoutSec: stepTimeoutSec, retries: 0 },
      );

      // upload-video — promote the artifact directory (video.webm +
      // trace.zip + report.json + any screenshots) to a signed R2 URL.
      // The `artifact` capability tars directories; the resulting URL
      // is the headline link reviewers click to fetch the bundle.
      const videoUri = yield* step("upload-video", () =>
        artifact.upload({
          name: "demo-bundle",
          path: `${dir}/${input.artifactPath}/`,
          container,
          contentType: "application/x-tar",
          signedUrlTTL: "30 days",
        }),
      );

      // upload-log — push the captured stdout/stderr to R2. Reviewers
      // open this when the demo failed and they need to see what
      // Playwright printed before the video cut off.
      const logUri = yield* step("upload-log", () =>
        artifact.upload({
          name: "playwright.log",
          path: exec.logPath,
          signedUrlTTL: "30 days",
        }),
      );

      yield* io.log(
        "info",
        `playwright-demo exited ${exec.exitCode} (${exec.durationMs}ms)`,
      );

      return {
        exitCode: exec.exitCode,
        durationMs: exec.durationMs,
        videoUri,
        logUri,
      };
    }),
});
