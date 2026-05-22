// @flare-dispatch/demo-agent — the play loop.
//
// One story = one bounded loop:
//
//   record chapterStartMs (wall-clock since Browser Rendering opened the
//                          session — Date.now() at attach time);
//   loop until done | max-actions | max-sec:
//     snapshot accessibility tree
//     ask Claude: next action?
//     apply via CDP
//     append to history (oldest first)
//     if the model said "screenshot", save it as the key screenshot path
//   record chapterEndMs
//   emit one JSON line on stdout (PlayOutput shape)
//
// The CdpSession interface keeps the loop unit-testable — `runPlayLoop` takes
// a fake session in tests, a real puppeteer-backed one in the CLI entry.

import { Effect, Match } from "effect";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { CdpSession } from "./cdp.js";
import { pickNextAction } from "./anthropic.js";
import { FsFailed, type AgentError } from "./errors.js";
import type { ModelAction, PlayOutput } from "./schemas.js";

export type PlayInput = {
  readonly name: string;
  readonly prose: string;
  readonly screenshotsDir: string;
  readonly maxSec: number;
  /** Hard ceiling on action count regardless of time. Default 20. */
  readonly maxActions?: number;
  /** Wall-clock at session attach time — chapter offsets ride off this. */
  readonly attachedAtMs: number;
  /** Model alias / id forwarded to `pickNextAction`. Default `claude-opus-4-7`. */
  readonly model?: string;
};

export type PlayDeps = {
  readonly session: CdpSession;
  /**
   * Inject the action picker for tests. Defaults to the live `pickNextAction`
   * which calls Anthropic.
   */
  readonly pickAction?: typeof pickNextAction;
  /** Current wall-clock; defaults to `Date.now`. */
  readonly now?: () => number;
};

const MAX_ACTIONS_DEFAULT = 20;
const FINAL_KEY_SCREENSHOT_FALLBACK = "final.png";

/**
 * Run the play loop for one story. Returns a fully-shaped `PlayOutput`; even
 * the failure paths (timeout, model error, CDP error) resolve to a
 * structured `{ status: "failed" }` so the run's `Effect.forEach` over
 * stories doesn't short-circuit on one bad story.
 */
export const runPlayLoop = (
  input: PlayInput,
  deps: PlayDeps,
): Effect.Effect<PlayOutput, FsFailed> =>
  Effect.gen(function* () {
    const now = deps.now ?? (() => Date.now());
    const pick = deps.pickAction ?? pickNextAction;
    const maxActions = input.maxActions ?? MAX_ACTIONS_DEFAULT;
    const chapterStartMs = now() - input.attachedAtMs;
    const startMs = now();
    const deadlineMs = startMs + input.maxSec * 1_000;

    yield* ensureDir(input.screenshotsDir);

    const history: string[] = [];
    let keyScreenshotPath: string | undefined;
    let narrative = "";
    let status: PlayOutput["status"] = "failed";
    let terminated: "done" | "max-actions" | "max-sec" | "error" =
      "max-actions";

    for (let i = 0; i < maxActions; i++) {
      const secsRemaining = Math.max(0, Math.round((deadlineMs - now()) / 1_000));
      if (secsRemaining === 0) {
        terminated = "max-sec";
        break;
      }

      // 1. Snapshot the page. CDP errors here mean we can't see the page,
      //    which is unrecoverable for this story — emit failed and exit.
      const snapshotResult = yield* deps.session.accessibilitySnapshot().pipe(
        Effect.either,
      );
      if (snapshotResult._tag === "Left") {
        narrative = `CDP error snapshotting page: ${snapshotResult.left.message}`;
        terminated = "error";
        break;
      }

      // 2. Ask the model for the next action. Same logic — a model error
      //    fails the story, not the whole run.
      const actionResult = yield* pick({
        prose: input.prose,
        snapshot: snapshotResult.right,
        history: [...history],
        secsRemaining,
        model: input.model,
      }).pipe(Effect.either);

      if (actionResult._tag === "Left") {
        narrative = `model error: ${actionResult.left.message}`;
        terminated = "error";
        break;
      }
      const action = actionResult.right;

      // 3. Apply the action. `done` exits the loop; other actions go through
      //    the CDP session and append to history.
      const applyResult = yield* applyAction(action, deps.session, {
        screenshotsDir: input.screenshotsDir,
        storyName: input.name,
      }).pipe(Effect.either);

      if (applyResult._tag === "Left") {
        const tag = (applyResult.left as { _tag?: string })._tag ?? "AgentError";
        narrative = `${tag} applying ${action.type}: ${describeError(applyResult.left)}`;
        terminated = "error";
        break;
      }

      const applied = applyResult.right;
      if (applied.kind === "screenshot") {
        keyScreenshotPath = applied.path;
      }
      history.push(describeAction(action));

      if (action.type === "done") {
        narrative = action.narrative;
        status = action.status;
        terminated = "done";
        break;
      }
    }

    // 4. Always take a final screenshot — if the model never emitted one
    //    explicitly, this becomes the key-screenshot fallback.
    if (keyScreenshotPath === undefined) {
      const fallback = path.join(
        input.screenshotsDir,
        `${input.name}.${FINAL_KEY_SCREENSHOT_FALLBACK}`,
      );
      const sc = yield* deps.session.screenshot(fallback).pipe(Effect.either);
      if (sc._tag === "Right") {
        keyScreenshotPath = fallback;
      } else {
        keyScreenshotPath = "";
      }
    }

    const endNow = now();
    const chapterEndMs = endNow - input.attachedAtMs;
    const durationMs = endNow - startMs;

    if (terminated === "max-actions" || terminated === "max-sec") {
      narrative =
        narrative ||
        `story did not signal done after ${maxActions} actions / ${input.maxSec}s budget`;
    }

    return {
      status,
      durationMs,
      chapterStartMs,
      chapterEndMs,
      narrative,
      keyScreenshotPath,
    };
  });

type Applied =
  | { kind: "applied" }
  | { kind: "screenshot"; path: string }
  | { kind: "done" };

const applyAction = (
  action: ModelAction,
  session: CdpSession,
  ctx: { readonly screenshotsDir: string; readonly storyName: string },
): Effect.Effect<Applied, AgentError> =>
  Match.value(action).pipe(
    Match.discriminatorsExhaustive("type")({
      click: ({ target }) =>
        session.click(target).pipe(Effect.as({ kind: "applied" as const })),
      type: ({ target, text }) =>
        session
          .type(target, text)
          .pipe(Effect.as({ kind: "applied" as const })),
      nav: ({ url }) =>
        session.goto(url).pipe(Effect.as({ kind: "applied" as const })),
      key: ({ key }) =>
        session.key(key).pipe(Effect.as({ kind: "applied" as const })),
      wait: ({ ms }) =>
        session.wait(ms).pipe(Effect.as({ kind: "applied" as const })),
      screenshot: () => {
        const target = path.join(ctx.screenshotsDir, `${ctx.storyName}.png`);
        return session
          .screenshot(target)
          .pipe(Effect.as({ kind: "screenshot" as const, path: target }));
      },
      done: () => Effect.succeed({ kind: "done" as const }),
    }),
  );

const describeAction = (action: ModelAction): string =>
  Match.value(action).pipe(
    Match.discriminatorsExhaustive("type")({
      click: ({ target }) => `click ${target}`,
      type: ({ target, text }) =>
        `type "${text.length > 24 ? `${text.slice(0, 24)}…` : text}" into ${target}`,
      nav: ({ url }) => `nav ${url}`,
      key: ({ key }) => `key ${key}`,
      wait: ({ ms }) => `wait ${ms}ms`,
      screenshot: () => "screenshot (key frame)",
      done: ({ status }) => `done (${status})`,
    }),
  );

const describeError = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message?: unknown }).message)
    : String(e);

const ensureDir = (dir: string): Effect.Effect<void, FsFailed> =>
  Effect.tryPromise({
    try: () => fs.mkdir(dir, { recursive: true }).then(() => undefined),
    catch: (e) =>
      new FsFailed({
        path: dir,
        op: "mkdir",
        message: e instanceof Error ? e.message : String(e),
      }),
  });
