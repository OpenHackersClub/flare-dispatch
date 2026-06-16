// FlareDispatch Action — the `collect-command` signal collector.
//
// The Action's optional `collect-command` input lets a consumer plug a
// vendor-specific observability collector into a dispatch WITHOUT the
// dispatcher ever learning the vendor. The command runs consumer-side (in the
// runner's workspace), prints `signals/v1` JSON to stdout, and the Action folds
// those signals into the dispatch `inputs` before signing.
//
// This module is the parse → validate → merge half (plus a thin `node:child_
// process` runner). It keeps the dispatcher the narrow waist: the contract is
// `@flare-dispatch/core`'s `signals/v1`, validated here so a malformed
// collector fails the Action with a clear message BEFORE anything is signed or
// POSTed. We import the canonical Schema + caps from `@flare-dispatch/core/
// signals` (which pulls in only `effect`, already bundled) so the Action can't
// drift from the run's input contract.

import { execSync } from "node:child_process";
import { Effect, Either, Schema } from "effect";
import {
  MAX_SIGNALS,
  SignalArray,
  type SignalT,
} from "@flare-dispatch/core/signals";
import { CollectCommandFailed, SignalsInvalid } from "./errors.js";

/** Last `max` chars of a stderr blob, for a runner-log annotation. */
const tail = (s: string, max = 1000): string =>
  s.length <= max ? s : `…${s.slice(s.length - max)}`;

const decodeSignals = Schema.decodeUnknownEither(SignalArray);

/**
 * Pull the signal array out of a parsed collector payload. Two shapes are
 * accepted: a bare `Signal[]`, or an object carrying a `signals` array
 * property. Anything else is `Left(reason)` — the caller turns that into a
 * `SignalsInvalid` and fails the Action.
 */
export const extractSignalArray = (
  parsed: unknown,
): Either.Either<readonly unknown[], string> => {
  if (Array.isArray(parsed)) return Either.right(parsed);
  if (parsed !== null && typeof parsed === "object" && "signals" in parsed) {
    const inner = (parsed as { signals: unknown }).signals;
    return Array.isArray(inner)
      ? Either.right(inner)
      : Either.left("the `signals` property is not an array");
  }
  return Either.left(
    "expected a JSON array of signals or an object with a `signals` array property",
  );
};

/**
 * Parse collector stdout and validate it against `signals/v1`. Returns the
 * decoded `Signal[]` or a `SignalsInvalid` describing why it was rejected.
 * Pure — no I/O — so the parse/validate path is unit-testable without spawning
 * a process.
 */
export const parseCollectedSignals = (
  stdout: string,
): Either.Either<readonly SignalT[], SignalsInvalid> => {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    // An empty stdout is a contract violation — the collector must print at
    // least `[]`. Treat it as such rather than silently injecting [].
    return Either.left(
      new SignalsInvalid({
        reason: "collect-command produced no stdout — expected `signals/v1` JSON (at least `[]`)",
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return Either.left(
      new SignalsInvalid({
        reason: `collect-command stdout is not valid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
    );
  }
  return extractSignalArray(parsed).pipe(
    Either.mapLeft((reason) => new SignalsInvalid({ reason })),
    Either.flatMap((raw) =>
      decodeSignals(raw).pipe(
        Either.mapLeft(
          (e) =>
            new SignalsInvalid({
              reason: `collected signals violate signals/v1: ${e.message}`,
            }),
        ),
      ),
    ),
  );
};

/**
 * Read the `signals` already present on the caller-supplied `inputs` object
 * (the JSON the workflow passed via the `inputs` action input). Returns
 * `Left(SignalsInvalid)` when present-but-malformed, `Right([])` when absent.
 * Caller-provided signals come FIRST in the merge (the workflow author's
 * signals outrank the collector's).
 */
export const existingInputSignals = (
  inputs: unknown,
): Either.Either<readonly SignalT[], SignalsInvalid> => {
  if (inputs === null || typeof inputs !== "object" || !("signals" in inputs)) {
    return Either.right([]);
  }
  const raw = (inputs as { signals: unknown }).signals;
  if (raw === undefined) return Either.right([]);
  if (!Array.isArray(raw)) {
    return Either.left(
      new SignalsInvalid({ reason: "`inputs.signals` is not an array" }),
    );
  }
  return decodeSignals(raw).pipe(
    Either.mapLeft(
      (e) =>
        new SignalsInvalid({
          reason: `inputs.signals violate signals/v1: ${e.message}`,
        }),
    ),
  );
};

/**
 * Merge caller-provided signals (first) with collected signals (appended) and
 * re-validate the combined array against the 50-item cap. Re-decoding the
 * concatenation is what enforces the cap on the SUM — neither side alone may be
 * over 50, but together they can be.
 */
export const mergeSignals = (
  existing: readonly SignalT[],
  collected: readonly SignalT[],
): Either.Either<readonly SignalT[], SignalsInvalid> => {
  const combined = [...existing, ...collected];
  return decodeSignals(combined).pipe(
    Either.mapLeft(
      () =>
        new SignalsInvalid({
          reason: `merged signals exceed the ${MAX_SIGNALS}-item cap (${existing.length} caller + ${collected.length} collected = ${combined.length})`,
        }),
    ),
  );
};

/** Result of running a `collect-command`: its stdout + a (passed-through) stderr. */
export interface CollectOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Hook so tests can drive the parse/merge logic without spawning a real
 * process. `runCollectCommand` provides the default `node:child_process`
 * implementation.
 */
export type RunCommand = (
  command: string,
  cwd: string,
) => Effect.Effect<CollectOutput, CollectCommandFailed>;

/**
 * Default `collect-command` runner. Executes the command in a shell with the
 * workspace as the working dir, captures stdout, and passes stderr THROUGH to
 * the runner log (so a collector's diagnostics are visible). A non-zero exit
 * fails the Action with the stderr tail — the collector contract is "always
 * exit 0", so a non-zero exit means the collector is broken.
 */
export const runCollectCommand: RunCommand = (command, cwd) =>
  Effect.try({
    try: (): CollectOutput => {
      // `stderr: 'inherit'` streams the collector's diagnostics straight to the
      // runner log; we only capture stdout (the JSON payload).
      const stdout = execSync(command, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout, stderr: "" };
    },
    catch: (cause): CollectCommandFailed => {
      // `execSync` throws an ExecException with `status` + captured `stderr`
      // when the process exits non-zero (or can't be spawned).
      const e = cause as {
        status?: number | null;
        stderr?: Buffer | string;
        message?: string;
      };
      const stderrStr =
        e.stderr === undefined
          ? (e.message ?? String(cause))
          : typeof e.stderr === "string"
            ? e.stderr
            : e.stderr.toString("utf8");
      return new CollectCommandFailed({
        exitCode: typeof e.status === "number" ? e.status : 1,
        stderrTail: tail(stderrStr),
      });
    },
  });

/**
 * Run a `collect-command`, validate its output, merge it onto the caller's
 * `inputs.signals`, and return the new `inputs` object with the merged
 * `signals` array spliced in. Fails (before any signing) with a tagged error
 * if the command exits non-zero or its output isn't a valid `signals/v1`
 * payload. DX: when the merged inputs carry signals but no `firedAt`, default
 * it to `Date.now()` — the `ci-triage-pr` run requires `firedAt`.
 *
 * `inputs` is the already-JSON-parsed caller `inputs` (an object, or whatever
 * the caller passed). Returns the augmented `inputs` for the dispatch body.
 */
export const collectAndMergeSignals = (params: {
  readonly command: string;
  readonly cwd: string;
  readonly inputs: unknown;
  readonly run?: RunCommand;
  readonly now?: () => number;
}): Effect.Effect<unknown, CollectCommandFailed | SignalsInvalid> =>
  Effect.gen(function* () {
    const run = params.run ?? runCollectCommand;
    const now = params.now ?? Date.now;

    const output = yield* run(params.command, params.cwd);
    const collected = yield* parseCollectedSignals(output.stdout);
    const existing = yield* existingInputSignals(params.inputs);
    const merged = yield* mergeSignals(existing, collected);

    // Preserve the caller's inputs object (or start one if they passed a
    // non-object / nothing) and splice the merged signals in.
    const base: Record<string, unknown> =
      params.inputs !== null && typeof params.inputs === "object"
        ? { ...(params.inputs as Record<string, unknown>) }
        : {};
    const next: Record<string, unknown> = { ...base, signals: merged };

    // DX: ci-triage-pr requires `firedAt`. If we're carrying signals but the
    // caller didn't set it, default it so the dispatch decodes.
    if (merged.length > 0 && next.firedAt === undefined) {
      next.firedAt = now();
    }
    return next;
  });
