// FlareDispatch CLI — `dispatch` subcommand.
//
// Effect-TS port of `actions/flare-dispatch-action/dispatch.sh`. Same
// contract:
//
//   * Inputs come from `INPUT_*` env vars (set by action.yml).
//   * `github.*` is sourced from GitHub Actions' `GITHUB_*` env vars.
//   * The body is JSON-serialized to bytes ONCE; those exact bytes are
//     HMAC-SHA256 signed AND POSTed (raw-bytes contract — see
//     apps/dispatcher/src/hmac.ts).
//   * POST `${ENDPOINT}/v1/dispatch/${RUN}` with `X-FlareDispatch-Signature:
//     sha256=<hex>`. HTTP 202 → log `executionId` + write to $GITHUB_OUTPUT.
//   * 401/400/404 fail immediately; transient (000/429/5xx) retry up to 3
//     attempts total with `attempt * backoffMs` backoff (5s, 10s by default).

import * as Command from "@effect/cli/Command";
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Console, Effect, Match, Schedule } from "effect";
import {
  BadResponse,
  MissingInput,
  PermanentFailure,
  TransientFailure,
} from "./errors.js";

/** Shape of the dispatch body — must match what `dispatch.sh` emits. */
export interface DispatchBody {
  readonly run: string;
  readonly github: {
    readonly repo: string;
    readonly ref: string;
    readonly sha: string;
    readonly actor?: string;
    readonly installation_id: number;
  };
  readonly inputs: unknown;
  readonly trigger: {
    readonly workflow_run_id?: number;
    readonly job_id?: string;
  };
}

/** Env-var sources the body is built from. Lifted so tests can inject. */
export interface DispatchEnv {
  readonly INPUT_RUN?: string;
  readonly INPUT_ENDPOINT?: string;
  readonly INPUT_HMAC_SECRET?: string;
  readonly INPUT_INPUTS?: string;
  readonly INPUT_INSTALLATION_ID?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_REF?: string;
  readonly GITHUB_SHA?: string;
  readonly GITHUB_ACTOR?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_JOB?: string;
  readonly GITHUB_OUTPUT?: string;
  readonly FLARE_RETRY_BACKOFF_MS?: string;
}

/**
 * Assemble the dispatch body from `INPUT_*` + `GITHUB_*` env vars. Mirrors
 * the inline `node -e` script in `dispatch.sh` exactly — in particular:
 *
 *   * `installation_id` defaults to `0` (not `undefined`).
 *   * `actor` is `undefined` when unset (and therefore omitted from the JSON).
 *   * `workflow_run_id` is `undefined` when unset or `0`.
 *   * `inputs` defaults to `{}` and is parsed from JSON.
 */
export const buildBody = (env: DispatchEnv): DispatchBody => {
  const runId = Number(env.GITHUB_RUN_ID ?? 0);
  return {
    run: env.INPUT_RUN ?? "",
    github: {
      repo: env.GITHUB_REPOSITORY ?? "",
      ref: env.GITHUB_REF ?? "refs/heads/main",
      sha: env.GITHUB_SHA ?? "",
      actor: env.GITHUB_ACTOR ? env.GITHUB_ACTOR : undefined,
      installation_id: Number(env.INPUT_INSTALLATION_ID ?? 0),
    },
    inputs: JSON.parse(env.INPUT_INPUTS ?? "{}") as unknown,
    trigger: {
      workflow_run_id: runId || undefined,
      job_id: env.GITHUB_JOB ? env.GITHUB_JOB : undefined,
    },
  };
};

/**
 * HMAC-SHA256 a buffer with `secret`, returning the `sha256=<hex>` header
 * value. Uses Node's `node:crypto` to stay zero-dep; produces the same hex
 * the Worker's `apps/dispatcher/src/hmac.ts#verify` accepts.
 */
export const signBytes = (secret: string, body: Uint8Array): string => {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
};

/** Read a required INPUT_* var; fail with a tagged error if missing. */
const requireInput = (
  env: DispatchEnv,
  key: keyof DispatchEnv,
  human: string,
): Effect.Effect<string, MissingInput> => {
  const value = env[key];
  return value && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new MissingInput({ name: human }));
};

/** Strip a single trailing `/` from the endpoint, matching `${VAR%/}` in bash. */
const stripTrailingSlash = (s: string): string =>
  s.endsWith("/") ? s.slice(0, -1) : s;

/** Default backoff base — overridable via `FLARE_RETRY_BACKOFF_MS` for tests. */
const backoffMs = (env: DispatchEnv): number => {
  const raw = env.FLARE_RETRY_BACKOFF_MS;
  if (!raw) return 5000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
};

/**
 * Categorize an HTTP status into the retry policy.
 *   * 202        → success (handled by caller)
 *   * 400/401/404 → permanent (no retry)
 *   * everything else (incl. 000 = network error) → transient
 */
const categorize = (
  status: number,
  body: string,
  attempt: number,
): PermanentFailure | TransientFailure =>
  Match.value(status).pipe(
    Match.when(
      (s) => s === 400 || s === 401 || s === 404,
      (s) => new PermanentFailure({ status: s, body, attempts: attempt }),
    ),
    Match.orElse(
      (s) => new TransientFailure({ status: s, body, attempt }),
    ),
  );

/** Shape we use for the fetch hook so tests can inject. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Uint8Array },
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultFetch: FetchLike = async (url, init) => {
  // Node 22 `fetch` accepts `Uint8Array` as the body. Treat any throw as a
  // network failure → status 000 (matches dispatch.sh's curl-fallback).
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return { status: res.status, text: () => res.text() };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { status: 0, text: () => Promise.resolve(message) };
  }
};

export interface DispatchDeps {
  readonly env: DispatchEnv;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/**
 * Single POST attempt. Lifted out so the retry schedule can rerun it without
 * re-signing (the signature is over the same bytes every attempt).
 */
const postOnce = (
  url: string,
  body: Uint8Array,
  signature: string,
  attempt: number,
  fetchImpl: FetchLike,
): Effect.Effect<
  { status: number; body: string },
  PermanentFailure | TransientFailure
> =>
  Effect.gen(function* () {
    const res = yield* Effect.promise(() =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlareDispatch-Signature": signature,
        },
        body,
      }),
    );
    const text = yield* Effect.promise(() => res.text());

    if (res.status === 202) return { status: 202, body: text };

    return yield* Effect.fail(categorize(res.status, text, attempt));
  });

/**
 * The dispatch flow. Pure-ish — takes its env and fetch from `deps` so the
 * test suite can drive it without process-level state. The CLI handler wires
 * `deps` to `process.env` + global `fetch`.
 */
export const runDispatch = (
  deps: DispatchDeps,
): Effect.Effect<
  { executionId: string },
  MissingInput | PermanentFailure | TransientFailure | BadResponse
> =>
  Effect.gen(function* () {
    const env = deps.env;
    const fetchImpl = deps.fetch ?? defaultFetch;

    const run = yield* requireInput(env, "INPUT_RUN", "run");
    const endpointRaw = yield* requireInput(env, "INPUT_ENDPOINT", "endpoint");
    const secret = yield* requireInput(env, "INPUT_HMAC_SECRET", "hmac-secret");

    const endpoint = stripTrailingSlash(endpointRaw);
    const url = `${endpoint}/v1/dispatch/${run}`;

    const body = buildBody(env);
    // Serialize ONCE — those exact bytes are what we sign AND what we send
    // (raw-bytes contract with the verifier).
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const signature = signBytes(secret, bytes);

    // Mutable so the schedule can advance it; Schedule.recurs handles the
    // bound, and `whileInput` keeps retrying only on TransientFailure.
    let attempt = 0;
    const attemptOnce = Effect.suspend(() => {
      attempt += 1;
      return postOnce(url, bytes, signature, attempt, fetchImpl).pipe(
        Effect.tapError((e) =>
          Match.value(e).pipe(
            Match.tag("TransientFailure", ({ status }) =>
              attempt < 3
                ? Console.log(
                    `FlareDispatch: transient failure (HTTP ${status}), retry ${attempt}/3...`,
                  )
                : Effect.void,
            ),
            Match.tag("PermanentFailure", () => Effect.void),
            Match.exhaustive,
          ),
        ),
      );
    });

    const base = backoffMs(env);
    // attempt * base before the NEXT attempt → 1*base after attempt 1,
    // 2*base after attempt 2. Schedule.recurs(2) gives us 2 retries on top of
    // the initial try (3 attempts total), matching dispatch.sh.
    const retrySchedule = Schedule.recurs(2).pipe(
      Schedule.addDelay(() => `${attempt * base} millis`),
      Schedule.whileInput(
        (e: PermanentFailure | TransientFailure) =>
          e._tag === "TransientFailure",
      ),
    );

    const result = yield* attemptOnce.pipe(Effect.retry(retrySchedule));

    // Parse executionId from the 202 body. A 202 without an executionId is a
    // BadResponse — we'd rather fail loudly than write an empty output.
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(result.body),
      catch: (cause) =>
        new BadResponse({
          body: result.body,
          reason:
            cause instanceof Error
              ? `JSON parse failed: ${cause.message}`
              : "JSON parse failed",
        }),
    });

    const executionId =
      parsed !== null &&
      typeof parsed === "object" &&
      "executionId" in parsed &&
      typeof (parsed as { executionId: unknown }).executionId === "string"
        ? (parsed as { executionId: string }).executionId
        : "";

    yield* Console.log(
      `FlareDispatch: dispatched '${run}' — executionId=${executionId}`,
    );

    // GHA writes outputs to `$GITHUB_OUTPUT`; absent outside a runner.
    const outputFile = env.GITHUB_OUTPUT;
    if (outputFile) {
      yield* Effect.sync(() =>
        appendFileSync(outputFile, `execution-id=${executionId}\n`),
      );
    }

    return { executionId };
  });

/**
 * Render a tagged failure as the GitHub-Actions error annotation + non-zero
 * exit. Matches the `::error::` lines `dispatch.sh` emits.
 */
const reportFailure = (
  e: MissingInput | PermanentFailure | TransientFailure | BadResponse,
): Effect.Effect<never, never, never> =>
  Match.value(e).pipe(
    Match.tag("MissingInput", ({ name }) =>
      Effect.gen(function* () {
        yield* Console.error(`::error::'${name}' input is required`);
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("PermanentFailure", ({ status, body }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::FlareDispatch dispatch failed (HTTP ${status}): ${body}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("TransientFailure", ({ status, body, attempt }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::FlareDispatch dispatch failed after ${attempt} attempts (HTTP ${status}): ${body}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("BadResponse", ({ reason, body }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::FlareDispatch dispatch failed (bad response): ${reason} — body=${body}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.exhaustive,
  );

/**
 * The `@effect/cli` `dispatch` subcommand. Takes no flags — every input is
 * an env var, matching the GHA Action contract.
 */
export const dispatchCommand = Command.make("dispatch", {}, () =>
  runDispatch({ env: process.env as DispatchEnv }).pipe(
    Effect.asVoid,
    Effect.catchAll(reportFailure),
  ),
);
