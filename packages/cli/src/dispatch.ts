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

import { createHash, createHmac } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { Console, Effect, Match, Schedule } from "effect";
import {
  BadMode,
  BadResponse,
  InvalidEndpoint,
  MissingInput,
  PermanentFailure,
  TransientFailure,
} from "./errors.js";

/**
 * Percent-encode `%`, `\r`, `\n` for safe interpolation into a GitHub Actions
 * workflow-command line (`::error::...`, `::warning::...`, etc.). Without
 * this, a Dispatcher response body containing `\n::set-output ...` would
 * inject a second workflow command into the runner. Encoding `%` FIRST is
 * load-bearing so we don't double-encode our own `%0A` / `%0D`. Matches
 * `@actions/core`'s `escapeData()` from `core/src/command.ts`.
 *
 * Security review H2 / L1 / L2.
 */
const escapeCmd = (s: string): string =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Cap any user/dispatcher-controlled string at 500 chars before it lands in
 * a runner log. A buggy or hostile Worker that returns a 50-KiB body would
 * otherwise spam the annotation and bury the actual error. Security
 * review M2.
 */
const truncateForLog = (s: string, max = 500): string =>
  s.length <= max ? s : `${s.slice(0, max)}… (truncated)`;

/** Compose escape + truncate — the only thing the reporter should inline. */
const safeForCmd = (s: string): string => escapeCmd(truncateForLog(s));

/** Shape of the dispatch body — must match what `dispatch.sh` emits. */
export interface DispatchBody {
  readonly run: string;
  readonly github: {
    readonly repo: string;
    readonly ref: string;
    readonly sha: string;
    readonly actor?: string;
    readonly installation_id?: number;
  };
  readonly inputs: unknown;
  readonly trigger: {
    readonly workflow_run_id?: number;
    readonly job_id?: string;
  };
}

/**
 * Env-var sources. A plain string-keyed map so tests can inject either the
 * `INPUT_*` convention GitHub Actions uses, or any of the alternate names
 * we accept for the same input (see `readInput`).
 */
export type DispatchEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolve a GHA Action input name to the env-var name the runner sets.
 *
 * GitHub Actions exposes inputs as `INPUT_<NAME>` where `<NAME>` is the
 * input name uppercased with **spaces** replaced by underscores — hyphens
 * stay literal. So `hmac-secret` becomes `INPUT_HMAC-SECRET`, not
 * `INPUT_HMAC_SECRET`. (This matches `@actions/core`'s `getInput` source.)
 *
 * For developer ergonomics (and to keep the unit tests readable) we ALSO
 * accept the all-underscore form `INPUT_HMAC_SECRET` — whichever is set
 * first wins. The old composite Action mapped its inputs explicitly via
 * `env: INPUT_HMAC_SECRET: ${{ inputs.hmac-secret }}`, so that form is
 * what the bash CLI used to see; we keep accepting it for forward-compat.
 */
const readInput = (env: DispatchEnv, name: string): string | undefined => {
  const ghaCanonical = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const underscored = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  const a = env[ghaCanonical];
  if (a !== undefined && a !== "") return a;
  const b = env[underscored];
  if (b !== undefined && b !== "") return b;
  return undefined;
};

/**
 * Resolve the SHA the run keys on — the commit the verdict check-run and the
 * executionId must attach to. On a `pull_request` / `pull_request_target`
 * event `GITHUB_SHA` is the ephemeral test-*merge* commit (a throwaway merge
 * of head into base that GitHub regenerates on every base change); a check-run
 * posted there is invisible on the PR head and branch protection cannot gate
 * it. The verdict belongs on the PR *head* SHA — the commit the author pushed.
 *
 * Read `pull_request.head.sha` from the event payload at `GITHUB_EVENT_PATH`.
 * Fall back to `GITHUB_SHA` for push events and whenever the payload is absent
 * or unreadable (the worst case is the prior behaviour, never a hard failure).
 */
export const resolveHeadSha = (env: DispatchEnv): string => {
  const fallback = env.GITHUB_SHA ?? "";
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return fallback;
  }
  const path = env.GITHUB_EVENT_PATH;
  if (path === undefined || path === "") return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      pull_request?: { head?: { sha?: string } };
    };
    const head = parsed.pull_request?.head?.sha;
    return head !== undefined && head !== "" ? head : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Assemble the dispatch body from input + `GITHUB_*` env vars. Mirrors the
 * inline `node -e` script the old `dispatch.sh` ran:
 *
 *   * `installation_id` is OMITTED (undefined → dropped from the JSON) when
 *     the input is unset or `<= 0`. `action.yml` documents it as optional —
 *     "when omitted, the Dispatcher resolves it server-side from the App's
 *     webhook-registered installation map" — and the dispatch schema is
 *     `positive | undefined`, so a literal `0` is rejected (HTTP 400). Sending
 *     a positive id passes it through unchanged.
 *   * `actor` is `undefined` when unset (and therefore omitted from the JSON).
 *   * `workflow_run_id` is `undefined` when unset or `0`.
 *   * `inputs` defaults to `{}` and is parsed from JSON.
 */
export const buildBody = (env: DispatchEnv): DispatchBody => {
  const runId = Number(env.GITHUB_RUN_ID ?? 0);
  return {
    run: readInput(env, "run") ?? "",
    github: {
      repo: env.GITHUB_REPOSITORY ?? "",
      ref: env.GITHUB_REF ?? "refs/heads/main",
      // PR head SHA on pull_request events, not the ephemeral merge commit —
      // so the check-run lands where branch protection can gate it.
      sha: resolveHeadSha(env),
      actor: env.GITHUB_ACTOR ? env.GITHUB_ACTOR : undefined,
      // Omit a 0/unset installation id (the dispatch schema is
      // `positive | undefined`; a literal 0 is a 400). The Dispatcher resolves
      // it server-side when absent.
      installation_id: ((id) => (id > 0 ? id : undefined))(
        Number(readInput(env, "installation-id") ?? 0),
      ),
    },
    inputs: JSON.parse(readInput(env, "inputs") ?? "{}") as unknown,
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

/**
 * Non-secret fingerprint of the HMAC secret — `sha256(secret)[:8]`, lowercase
 * hex. Matches the dispatcher's `fingerprint()` in
 * `apps/dispatcher/src/hmac.ts` so the two sides can be compared in 401 drift
 * diagnostics. Sensitive to whitespace — a trailing `\n` smuggled in by
 * `wrangler secret put` flips the fingerprint (issue #24, the dominant 401
 * failure mode this primitive exists to catch).
 */
export const secretFingerprint = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex").slice(0, 8);

/** Read a required Action input; fail with a tagged error if missing. */
const requireInput = (
  env: DispatchEnv,
  name: string,
): Effect.Effect<string, MissingInput> => {
  const value = readInput(env, name);
  return value !== undefined
    ? Effect.succeed(value)
    : Effect.fail(new MissingInput({ name }));
};

/** Strip a single trailing `/` from the endpoint, matching `${VAR%/}` in bash. */
const stripTrailingSlash = (s: string): string =>
  s.endsWith("/") ? s.slice(0, -1) : s;

/**
 * Compute an `Idempotency-Key` per spec 04-gha § Dispatch body — "the GHA
 * Action generates one per dispatch." Derived from `{run, repo, sha[:12]}`
 * so two retries of the same GHA step (e.g. a re-run after a transient
 * failure) collapse onto one execution at the receiver. Falls back to a
 * timestamp-randomized form if `repo` or `sha` is missing.
 *
 * Uses `-` as the separator (PR #22 fix — `:` was unsafe for KV keys).
 */
export const computeIdempotencyKey = (
  env: DispatchEnv,
  run: string,
): string => {
  const repo = env.GITHUB_REPOSITORY ?? "";
  // Key idempotency on the same SHA the body + check-run use (PR head on PR
  // events) so a step re-run collapses onto one execution per head commit.
  const sha = resolveHeadSha(env);
  if (repo !== "" && sha !== "") {
    const repoSafe = repo.replace(/\//g, "_");
    const shaShort = sha.slice(0, 12);
    return `${run}-${repoSafe}-${shaShort}`;
  }
  return `${run}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
};

/** Default backoff base — overridable via `FLARE_RETRY_BACKOFF_MS` for tests. */
const backoffMs = (env: DispatchEnv): number => {
  const raw = env.FLARE_RETRY_BACKOFF_MS;
  if (!raw) return 5000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
};

/**
 * Try to extract `dispatcher_secret_fingerprint` from a 401 body. The
 * Worker returns `{ error, message, dispatcher_secret_fingerprint }` on HMAC
 * drift (apps/dispatcher/src/routes/dispatch.ts) — anything else (non-JSON,
 * field missing, wrong type) is reported as `<not provided>` so the operator
 * still sees the local fingerprint and isn't blocked.
 */
const parseDispatcherFingerprint = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "dispatcher_secret_fingerprint" in parsed &&
      typeof (parsed as { dispatcher_secret_fingerprint: unknown })
        .dispatcher_secret_fingerprint === "string"
    ) {
      return (parsed as { dispatcher_secret_fingerprint: string })
        .dispatcher_secret_fingerprint;
    }
  } catch {
    // fall through
  }
  return "<not provided>";
};

/**
 * Categorize an HTTP status into the retry policy.
 *   * 202        → success (handled by caller)
 *   * 400/401/404 → permanent (no retry); 401 also carries the two
 *                   HMAC fingerprints for drift diagnostics
 *   * everything else (incl. 000 = network error) → transient
 */
const categorize = (
  status: number,
  body: string,
  attempt: number,
  localFingerprint: string,
): PermanentFailure | TransientFailure =>
  Match.value(status).pipe(
    Match.when(
      (s) => s === 401,
      () =>
        new PermanentFailure({
          status: 401,
          body,
          attempts: attempt,
          localFingerprint,
          dispatcherFingerprint: parseDispatcherFingerprint(body),
        }),
    ),
    Match.when(
      (s) => s === 400 || s === 404,
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
}

/**
 * Single POST attempt. Lifted out so the retry schedule can rerun it without
 * re-signing (the signature is over the same bytes every attempt).
 */
const postOnce = (
  url: string,
  body: Uint8Array,
  signature: string,
  idempotencyKey: string,
  attempt: number,
  fetchImpl: FetchLike,
  localFingerprint: string,
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
          "Idempotency-Key": idempotencyKey,
        },
        body,
      }),
    );
    const text = yield* Effect.promise(() => res.text());

    if (res.status === 202) return { status: 202, body: text };

    return yield* Effect.fail(
      categorize(res.status, text, attempt, localFingerprint),
    );
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
  | BadMode
  | MissingInput
  | InvalidEndpoint
  | PermanentFailure
  | TransientFailure
  | BadResponse
> =>
  Effect.gen(function* () {
    const env = deps.env;
    const fetchImpl = deps.fetch ?? defaultFetch;

    // V0 only supports fire-and-forget mode. Reject anything else before
    // touching the network — same message the composite "Validate mode" step
    // emitted, now folded into the JS-Action entry.
    const mode = readInput(env, "mode") ?? "fire-and-forget";
    if (mode !== "fire-and-forget") {
      return yield* Effect.fail(new BadMode({ mode }));
    }

    const run = yield* requireInput(env, "run");
    const endpointRaw = yield* requireInput(env, "endpoint");
    const secret = yield* requireInput(env, "hmac-secret");

    // Validate scheme BEFORE any network attempt — keeps `file://`, `data:`,
    // `ftp:`, and cloud-metadata-only URLs from reaching `fetch`. Security
    // review M1. We accept `http:` too (for `wrangler dev` smokes); operator
    // hygiene around clear-text is documented separately.
    const endpoint = stripTrailingSlash(endpointRaw);
    const parsedEndpoint = yield* Effect.try({
      try: () => new URL(endpoint),
      catch: (cause) =>
        new InvalidEndpoint({
          endpoint,
          reason:
            cause instanceof Error
              ? `not a valid URL: ${cause.message}`
              : "not a valid URL",
        }),
    });
    if (
      parsedEndpoint.protocol !== "https:" &&
      parsedEndpoint.protocol !== "http:"
    ) {
      return yield* Effect.fail(
        new InvalidEndpoint({
          endpoint,
          reason: `unsupported scheme ${parsedEndpoint.protocol} — only http(s) allowed`,
        }),
      );
    }

    // `encodeURIComponent(run)` keeps a path-traversal `..` or query-injection
    // `?` from rewriting the request. The HMAC is over the body, not the URL,
    // so a path rewrite would otherwise let a hostile workflow author pivot
    // the (signed) request to a different endpoint. Security review M4.
    const url = `${endpoint}/v1/dispatch/${encodeURIComponent(run)}`;

    const body = buildBody(env);
    // Serialize ONCE — those exact bytes are what we sign AND what we send
    // (raw-bytes contract with the verifier).
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const signature = signBytes(secret, bytes);

    // Computed once — threaded into a 401 PermanentFailure so the reporter
    // can print it next to the dispatcher's fingerprint (issue #24).
    const localFp = secretFingerprint(secret);

    // Idempotency-Key per spec 04-gha § Dispatch body — same key for every
    // retry attempt so the receiver collapses GHA re-runs of the same step.
    const idempotencyKey = computeIdempotencyKey(env, run);

    // Mutable so the schedule can advance it; Schedule.recurs handles the
    // bound, and `whileInput` keeps retrying only on TransientFailure.
    let attempt = 0;
    const attemptOnce = Effect.suspend(() => {
      attempt += 1;
      return postOnce(
        url,
        bytes,
        signature,
        idempotencyKey,
        attempt,
        fetchImpl,
        localFp,
      ).pipe(
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

    // `safeForCmd` keeps a hostile `run` or `executionId` from injecting a
    // second workflow command into the runner log (security review H2/L1).
    yield* Console.log(
      `FlareDispatch: dispatched '${safeForCmd(run)}' — executionId=${safeForCmd(executionId)}`,
    );

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
export const reportFailure = (
  e:
    | BadMode
    | MissingInput
    | InvalidEndpoint
    | PermanentFailure
    | TransientFailure
    | BadResponse,
): Effect.Effect<never, never, never> =>
  Match.value(e).pipe(
    Match.tag("BadMode", ({ mode }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::mode='${safeForCmd(mode)}' — await mode is not implemented in V0 (deferred to V1, see specs/pm/plan.md § 2). Use mode: fire-and-forget.`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("MissingInput", ({ name }) =>
      Effect.gen(function* () {
        yield* Console.error(`::error::'${safeForCmd(name)}' input is required`);
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("InvalidEndpoint", ({ endpoint, reason }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::'endpoint' input is invalid (${safeForCmd(reason)}): ${safeForCmd(endpoint)}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.tag(
      "PermanentFailure",
      ({ status, body, localFingerprint, dispatcherFingerprint }) =>
        Effect.gen(function* () {
          yield* Console.error(
            `::error::FlareDispatch dispatch failed (HTTP ${status}): ${safeForCmd(body)}`,
          );
          // 401 → HMAC drift between flare-dispatch-action and the Worker.
          // Print both fingerprints so the operator can pinpoint which side
          // holds the wrong secret (issue #24). Fingerprints are
          // sha256(secret)[:8] — escape anyway as defense-in-depth.
          if (status === 401 && localFingerprint !== undefined) {
            yield* Console.error(
              "::error::HMAC drift between flare-dispatch-action and Dispatcher Worker.",
            );
            yield* Console.error(
              `  local secret fingerprint      = ${safeForCmd(localFingerprint)}`,
            );
            yield* Console.error(
              `  dispatcher secret fingerprint = ${safeForCmd(
                dispatcherFingerprint ?? "<not provided>",
              )}`,
            );
            yield* Console.error(
              "  → if they differ, re-sync the secret on the mismatching side",
            );
            yield* Console.error(
              "  → if they match, the canonicalization contract has drifted (file a separate bug)",
            );
          }
          return yield* Effect.die(e);
        }),
    ),
    Match.tag("TransientFailure", ({ status, body, attempt }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::FlareDispatch dispatch failed after ${attempt} attempts (HTTP ${status}): ${safeForCmd(body)}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("BadResponse", ({ reason, body }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `::error::FlareDispatch dispatch failed (bad response): ${safeForCmd(reason)} — body=${safeForCmd(body)}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.exhaustive,
  );

// The `@effect/cli` `dispatch` subcommand lives in `./command.ts` so that
// the JS-Action entry (`action-entry.ts`) — which doesn't need an argv
// parser — can pull in `runDispatch` + `reportFailure` without dragging
// `@effect/cli` into the bundle.
