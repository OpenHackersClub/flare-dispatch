// @flare-dispatch/core — defineRun.
//
// `defineRun` is a passive constructor: it validates the spec at module load
// and registers the run for discovery. It binds to no runtime — the same Run
// value executes against CFRuntimeLive, Dev, or Test (specs/03-dsl.md § Layers).
//
// Spec: specs/03-dsl.md § defineRun.

import type { Effect, Schema } from "effect";
import type { RunContext } from "./context";
import type { RunError } from "./errors";

export type RunLimits = {
  readonly maxDurationSec: number;
  readonly maxConcurrency?: number;
  readonly requiresBrowser?: boolean;
};

/** The raw GitHub webhook delivery; a run narrows it per-event itself. */
export type WebhookPayload = Record<string, any>;

/** A single Webhook-mode trigger binding — see specs/04-gha-integration.md. */
export type TriggerSpec<I> = {
  readonly event: string;
  readonly actions?: readonly string[];
  readonly idempotencyKey: (ctx: { payload: WebhookPayload }) => string;
  readonly gate?: (ctx: { payload: WebhookPayload }) => boolean;
  readonly inputs: (ctx: { payload: WebhookPayload }) => I;
};

/**
 * The context a cron tick provides — there is no GitHub payload.
 * See specs/03-dsl.md § `ScheduleContext`.
 */
export type ScheduleContext = {
  readonly cron: string;
  readonly firedAt: number;
};

/**
 * A single Schedule-mode trigger binding — see specs/04-gha-integration.md
 * § Schedule mode. Mirrors `TriggerSpec` but the callbacks receive a
 * `ScheduleContext` (no webhook payload). `inputs` produces a *scope*, not a
 * concrete target — for single-target runs (e.g. nightly-e2e against a fixed
 * env), the input is the full body; for sweeps, it's coarse and the run
 * enumerates targets in its first step.
 */
export type ScheduleSpec<I> = {
  /** CF cron expression; MUST also be in wrangler `triggers.crons`. */
  readonly cron: string;
  readonly idempotencyKey: (ctx: ScheduleContext) => string;
  readonly gate?: (ctx: ScheduleContext) => boolean;
  readonly inputs: (ctx: ScheduleContext) => I;
};

/**
 * Which baked sandbox image a run executes in. The dispatcher maps this to a
 * deployed Container binding (`RUNS_SANDBOX` vs `RUNS_SANDBOX_BROWSER`) — see
 * apps/dispatcher/src/workflow.ts.
 *
 *   - `"lean"` (default) — the base sandbox image. Correct for the majority of
 *     runs AND for every `limits.requiresBrowser: true` run: those dial CF
 *     Browser Rendering over CDP (they connect *out* to a CF-managed browser),
 *     so they need NO chromium baked in the image.
 *   - `"browser"` — the image with `chromium-headless-shell` baked in. Only for
 *     runs that launch Playwright's OWN chromium *inside* the sandbox (e.g.
 *     `playwright-demo`, which is `requiresBrowser: false`).
 *
 * NOTE this axis is deliberately distinct from `limits.requiresBrowser`. They
 * answer different questions: `requiresBrowser` = "reserve a CF Browser
 * Rendering slot"; `sandboxImage` = "which container image to boot". A run can
 * be `requiresBrowser: true, sandboxImage: "lean"` (CDP, no in-image browser)
 * or `requiresBrowser: false, sandboxImage: "browser"` (in-sandbox Playwright).
 */
export type SandboxImage = "lean" | "browser";

export type RunSpec<I, O, IEnc, OEnc> = {
  readonly name: string;
  readonly version: string;
  /**
   * A fully-qualified container image URI override (e.g.
   * `registry.cloudflare.com/<acct>/<repo>:<tag>`) declaring the image this run
   * is BUILT to run in. Documentary today — several runs set it (`pr-review`,
   * `playwright-e2e`, `release-notes`) but the CF runtime does not yet pull a
   * per-run registry image; Container images are bound to DO classes at deploy.
   *
   * Do NOT confuse with `sandboxImage` below: `image` names a *specific
   * registry artifact* (a future per-run image-pull knob); `sandboxImage`
   * selects which of the deploy's ALREADY-BOUND images (`"lean" | "browser"`)
   * the dispatcher routes to — and is the field that actually drives routing.
   */
  readonly image?: string;
  /** Which baked, deploy-bound sandbox image to route this run to. Default
   * `"lean"`. Drives the dispatcher's Container-binding selection — see
   * `SandboxImage` above. */
  readonly sandboxImage?: SandboxImage;
  readonly inputs: Schema.Schema<I, IEnc>;
  readonly outputs: Schema.Schema<O, OEnc>;
  readonly limits: RunLimits;
  readonly triggers?: readonly TriggerSpec<I>[];
  readonly schedules?: readonly ScheduleSpec<I>[];
  readonly run: (input: I) => Effect.Effect<O, RunError, RunContext>;
};

/** A defined run — a portable value, not bound to any runtime. */
export type Run<I, O> = RunSpec<I, O, unknown, unknown> & {
  readonly _tag: "Run";
};

/** kebab-case: lowercase alphanumerics, single hyphens, no leading/trailing. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A pragmatic semver match — `major.minor.patch` with optional pre-release. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export const defineRun = <I, O, IEnc, OEnc>(
  spec: RunSpec<I, O, IEnc, OEnc>,
): Run<I, O> => {
  // Load-time validation: a malformed run spec is a build-time bug, not a
  // dispatch-time surprise — fail fast at module load. (specs/03-dsl.md
  // § defineRun: "validates the spec at module load".)
  if (!KEBAB_CASE.test(spec.name)) {
    throw new Error(
      `defineRun: \`name\` must be kebab-case, got ${JSON.stringify(spec.name)}`,
    );
  }
  if (!SEMVER.test(spec.version)) {
    throw new Error(
      `defineRun: \`version\` must be semver (major.minor.patch), got ${JSON.stringify(
        spec.version,
      )} for run "${spec.name}"`,
    );
  }
  if (
    !Number.isFinite(spec.limits.maxDurationSec) ||
    spec.limits.maxDurationSec <= 0
  ) {
    throw new Error(
      `defineRun: \`limits.maxDurationSec\` must be a positive number, got ${spec.limits.maxDurationSec} for run "${spec.name}"`,
    );
  }
  return { ...spec, _tag: "Run" } as Run<I, O>;
};
