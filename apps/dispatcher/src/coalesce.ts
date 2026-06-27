// FlareDispatch Dispatcher — trailing-coalesce spawn.
//
// The companion to `cooldown.ts`. A bare fixed-window cap reviews the first
// commit of a burst and drops the rest, so a PR's FINAL state can go unreviewed
// until the next push. When a run declares `cooldown.coalesce` and a dispatch
// lands inside the window (`CooldownVerdict.cooling`), BOTH dispatch entry
// points — the webhook receiver and Action-mode `/v1/dispatch` — call
// `spawnTrailingCoalescer` to start the coalescer run ONCE per window. It sleeps
// out the remaining window then re-dispatches the target against the latest
// head (specs/04-gha-integration.md § Trailing coalesce).
//
// Two invariants:
//   * ONE coalescer per window. The instance id is derived from the window's
//     prior execution id (`coalesce:<priorExecutionId>`), which is stable for
//     the whole window — so the first collapsed push creates it and every later
//     collapsed push in the same window is a `create({id})` no-op. (CF Workflows
//     ids are permanently consumed, which is WHY the id keys off the window, not
//     the PR: a fixed per-PR id could never re-arm for the next window.)
//   * BEST-EFFORT. A spawn failure must never turn the `cooling` 202 into an
//     error — the cap already held; the trailing review is an enhancement. Every
//     failure (duplicate id, binding hiccup) is swallowed.

import { toInstanceId } from "./instance-id";
import type { Env } from "./env";

/** Everything the trailing spawn needs — assembled at the `cooling` branch. */
export interface CoalesceArgs {
  /** The run that cooled (re-dispatched against the latest head) — e.g. `pr-review`. */
  readonly cooledRun: string;
  /** The coalescer run to start — `cooldown.coalesce.run` (e.g. `pr-review-trail`). */
  readonly coalesceRun: string;
  /** The window's prior execution id — the stable per-window discriminator. */
  readonly priorExecutionId: string;
  /** Seconds until the window reopens — the coalescer's durable sleep. */
  readonly retryAfterSec: number;
  /** "owner/name". */
  readonly repo: string;
  /** The PR number (coalesce only applies to PR-numbered dispatches). */
  readonly pr: number;
  /** The triggering push's ref + sha — recorded on the coalescer's github block. */
  readonly ref: string;
  readonly sha: string;
  /** App installation id — threaded so the coalescer's GitHub reads authenticate. */
  readonly installationId?: number;
  /**
   * Absolute origin for any artifact URLs. Optional — the coalescer mints none
   * (no sandbox, no artifacts), and the webhook path has no request origin handy.
   */
  readonly origin?: string;
}

/**
 * Start the trailing coalescer for a window, idempotently and best-effort. Never
 * throws — a failure leaves the `cooling` answer unchanged.
 */
export const spawnTrailingCoalescer = async (
  env: Env,
  args: CoalesceArgs,
): Promise<void> => {
  // Per-window id: the prior execution id is constant across the window, so the
  // first collapsed push wins the create and the rest no-op.
  const trailId = toInstanceId(`coalesce:${args.priorExecutionId}`);

  const params = {
    executionId: trailId,
    run: args.coalesceRun,
    github: {
      repo: args.repo,
      ref: args.ref,
      sha: args.sha,
      pr_number: args.pr,
      ...(args.installationId !== undefined
        ? { installation_id: args.installationId }
        : {}),
    },
    inputs: {
      repo: args.repo,
      pr: args.pr,
      sleepSec: args.retryAfterSec,
      targetRun: args.cooledRun,
      ...(args.installationId !== undefined
        ? { installationId: args.installationId }
        : {}),
    },
    ...(args.origin !== undefined ? { origin: args.origin } : {}),
  };

  try {
    await env.RUNS_WORKFLOW.create({ id: trailId, params });
  } catch (cause) {
    // A duplicate id (the window's coalescer already exists) is the intended
    // no-op; any OTHER failure is swallowed too — the trailing review is an
    // enhancement on top of an already-enforced cap, never load-bearing.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/already.?exists|duplicate/i.test(message)) {
      console.error(
        `[coalesce] trail spawn failed run="${args.coalesceRun}" id="${trailId}": ${message}`,
      );
    }
  }
};
