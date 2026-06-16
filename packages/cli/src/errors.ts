// FlareDispatch CLI — tagged errors for the dispatch flow.
//
// Errors are `Schema.TaggedError` so they are serializable, pattern-matchable
// via `Effect.catchTag` / `Match.tag`, and carry typed payloads. The retry
// `Schedule.whileInput` predicate keys off `_tag === "TransientFailure"` —
// that's the documented predicate API and is the one place tag access is
// idiomatic.

import { Schema } from "effect";

/** A required `INPUT_*` env var was missing. Fatal at startup. */
export class MissingInput extends Schema.TaggedError<MissingInput>()(
  "MissingInput",
  { name: Schema.String },
) {}

/**
 * `INPUT_MODE` was anything other than `fire-and-forget`. V0 only supports
 * fire-and-forget; `await` mode is deferred to V1 (specs/pm/plan.md § 2).
 * The Action used to enforce this in a separate composite "Validate mode"
 * step — folded into the CLI here so the JS-Action entry can reject it
 * before doing any work.
 */
export class BadMode extends Schema.TaggedError<BadMode>()(
  "BadMode",
  { mode: Schema.String },
) {}

/**
 * `INPUT_ENDPOINT` did not parse as a URL with an http(s) scheme. Rejected
 * before any network call so a hostile or typo'd endpoint (e.g. `file://`,
 * `data:`, `ftp:`) can't be reached by `fetch` at all. Security review M1.
 */
export class InvalidEndpoint extends Schema.TaggedError<InvalidEndpoint>()(
  "InvalidEndpoint",
  { endpoint: Schema.String, reason: Schema.String },
) {}

/**
 * A non-retryable HTTP response (401/400/404). The body is whatever the
 * Dispatcher returned — surfaced in the `::error::` line.
 *
 * On 401 (HMAC drift), both `localFingerprint` and `dispatcherFingerprint`
 * are populated — they're `sha256(secret)[:8]` for each side. The reporter
 * prints them so an operator can pinpoint which side has the wrong value.
 * See `apps/dispatcher/src/hmac.ts § fingerprint` and issue #24.
 */
export class PermanentFailure extends Schema.TaggedError<PermanentFailure>()(
  "PermanentFailure",
  {
    status: Schema.Number,
    body: Schema.String,
    attempts: Schema.Number,
    localFingerprint: Schema.optional(Schema.String),
    dispatcherFingerprint: Schema.optional(Schema.String),
  },
) {}

/**
 * A retryable failure — connection error (status `000`), 429, or 5xx. The
 * retry schedule keys off this tag.
 */
export class TransientFailure extends Schema.TaggedError<TransientFailure>()(
  "TransientFailure",
  {
    status: Schema.Number,
    body: Schema.String,
    attempt: Schema.Number,
  },
) {}

/**
 * The Dispatcher returned 202 but the JSON body could not be parsed for an
 * `executionId`. Fail loudly rather than emit an empty `execution-id` output.
 */
export class BadResponse extends Schema.TaggedError<BadResponse>()(
  "BadResponse",
  {
    body: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * The `collect-command` exited non-zero. The signals collector contract is
 * "always exit 0 with a (possibly empty) array" — a non-zero exit means the
 * collector itself is broken, so we fail the dispatch BEFORE signing rather
 * than silently dropping signals. `stderrTail` carries the tail of the
 * command's stderr for the operator.
 */
export class CollectCommandFailed extends Schema.TaggedError<CollectCommandFailed>()(
  "CollectCommandFailed",
  {
    exitCode: Schema.Number,
    stderrTail: Schema.String,
  },
) {}

/**
 * The `collect-command` ran but its stdout could not be turned into a valid
 * `signals/v1` payload — not JSON, not a `Signal[]` / `{ signals: [...] }`
 * shape, or it (or the merge with caller-provided signals) violated the
 * contract caps. Rejected before signing so a malformed collector never
 * produces a dispatch.
 */
export class SignalsInvalid extends Schema.TaggedError<SignalsInvalid>()(
  "SignalsInvalid",
  { reason: Schema.String },
) {}
