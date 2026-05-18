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

export type RunSpec<I, O, IEnc, OEnc> = {
  readonly name: string;
  readonly version: string;
  readonly image?: string;
  readonly inputs: Schema.Schema<I, IEnc>;
  readonly outputs: Schema.Schema<O, OEnc>;
  readonly limits: RunLimits;
  readonly triggers?: readonly TriggerSpec<I>[];
  readonly run: (input: I) => Effect.Effect<O, RunError, RunContext>;
};

/** A defined run — a portable value, not bound to any runtime. */
export type Run<I, O> = RunSpec<I, O, unknown, unknown> & {
  readonly _tag: "Run";
};

export const defineRun = <I, O, IEnc, OEnc>(
  spec: RunSpec<I, O, IEnc, OEnc>,
): Run<I, O> => {
  // Validation (unique kebab-case `name`, semver `version`, a positive
  // `limits.maxDurationSec`) and registry insertion run here, at module load.
  return { ...spec, _tag: "Run" } as Run<I, O>;
};
