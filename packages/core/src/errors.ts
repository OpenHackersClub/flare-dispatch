// @flare-dispatch/core — tagged run errors.
//
// Every failure a run can produce is a Schema.TaggedError: serializable,
// pattern-matchable with Match.tag, and carrying a typed payload. Runs recover
// with Effect.catchTag / catchTags; anything uncaught fails the execution with
// the full Cause attached to the check-run summary.
//
// Spec: specs/03-dsl.md § Errors.

import { Schema } from "effect";

export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()(
  "CheckoutFailed",
  { repo: Schema.String, sha: Schema.String, cause: Schema.Unknown },
) {}

export class ExecFailed extends Schema.TaggedError<ExecFailed>()(
  "ExecFailed",
  { exitCode: Schema.Number, stderrTail: Schema.String },
) {}

export class ExecTimeout extends Schema.TaggedError<ExecTimeout>()(
  "ExecTimeout",
  { timeoutSec: Schema.Number, command: Schema.String },
) {}

/**
 * A container file read failed (missing path, binary content, transport
 * error). Raised by `sandbox.readFile` — the path runs use to move command
 * output larger than the inlined `ExecResult.stdout` tail out of a container.
 */
export class ReadFileFailed extends Schema.TaggedError<ReadFileFailed>()(
  "ReadFileFailed",
  { path: Schema.String, message: Schema.String },
) {}

/**
 * A run's command/suite ran to completion but exited non-zero (a real test
 * failure). A run raises this to fail itself so the dispatcher reports a
 * `failure` check-run — distinct from `ExecFailed` (the process could not run
 * at all).
 */
export class AcceptanceFailed extends Schema.TaggedError<AcceptanceFailed>()(
  "AcceptanceFailed",
  {
    exitCode: Schema.Number,
    /**
     * Optional run-authored failure presentation — markdown the dispatcher
     * embeds beneath the generic "execution failed" line in the check-run
     * summary (and the notify email), so a red check explains itself instead
     * of pointing at R2. A run that already builds a human-readable verdict
     * (e.g. `product-demo`'s per-chapter table) attaches it here; absent ⇒
     * the generic line renders alone, exactly as before.
     */
    summaryMd: Schema.optional(Schema.String),
  },
) {}

export class ContainerLaunchFailed extends Schema.TaggedError<ContainerLaunchFailed>()(
  "ContainerLaunchFailed",
  { image: Schema.String, cause: Schema.Unknown },
) {}

export class PortNeverOpened extends Schema.TaggedError<PortNeverOpened>()(
  "PortNeverOpened",
  {
    port: Schema.Number,
    timeoutSec: Schema.Number,
    /**
     * R2 key of the detached process's captured stdout/stderr at the moment
     * the wait timed out, when log capture succeeded. A detached boot fails
     * with no other diagnostic — this is the only window into *why* the port
     * never opened. `undefined` when the runtime could not capture logs (e.g.
     * the process had already vanished), so a capture failure never masks the
     * original timeout.
     */
    logPath: Schema.optional(Schema.String),
  },
) {}

export class ExposePortFailed extends Schema.TaggedError<ExposePortFailed>()(
  "ExposePortFailed",
  { port: Schema.Number, cause: Schema.Unknown },
) {}

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  {
    reason: Schema.Literal("quota", "transient", "session-cap"),
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

/**
 * Render an error's `cause` field for `message` getters. The Workflows
 * attempt record only persists `error.name` + `error.message` — a swallowed
 * cause turns a diagnosable failure ("readFile: encoding 'none' requires the
 * rpc transport") into an opaque artifact name (#88). Keep it short: the
 * attempt record is a log line, not a stack dump.
 */
const renderCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export class CacheError extends Schema.TaggedError<CacheError>()(
  "CacheError",
  {
    phase: Schema.Literal("restore", "save"),
    key: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `cache ${this.phase} "${this.key}" failed: ${renderCause(this.cause)}`;
  }
}

export class ArtifactUploadFailed extends Schema.TaggedError<ArtifactUploadFailed>()(
  "ArtifactUploadFailed",
  { name: Schema.String, cause: Schema.Unknown },
) {
  // NOTE: the `name` FIELD shadows `Error.name` on instances — the attempt
  // record's name/message pair is the only diagnostic surface, so the
  // message must carry both the artifact name and the cause (#88).
  override get message(): string {
    return `artifact "${this.name}" upload failed: ${renderCause(this.cause)}`;
  }
}

export class StepFailed extends Schema.TaggedError<StepFailed>()(
  "StepFailed",
  { step: Schema.String, cause: Schema.Unknown },
) {}

export class ApprovalTimedOut extends Schema.TaggedError<ApprovalTimedOut>()(
  "ApprovalTimedOut",
  { eventName: Schema.String, timeoutMs: Schema.Number },
) {}

export class EventPayloadInvalid extends Schema.TaggedError<EventPayloadInvalid>()(
  "EventPayloadInvalid",
  { eventName: Schema.String, reason: Schema.String },
) {}

export class SecretsMissing extends Schema.TaggedError<SecretsMissing>()(
  "SecretsMissing",
  { keys: Schema.Array(Schema.String) },
) {}

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()(
  "GitHubApiError",
  {
    status: Schema.Number,
    reason: Schema.Literal(
      "rate-limited",
      "unauthorized",
      "transient",
      "other",
    ),
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    status: Schema.Number,
    reason: Schema.Literal(
      "rate-limited",
      "unauthorized",
      "transient",
      "other",
    ),
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

export class OidcSigningFailed extends Schema.TaggedError<OidcSigningFailed>()(
  "OidcSigningFailed",
  {
    // "key-load" — signing key absent or malformed;
    // "subtle-sign" — WebCrypto SubtleCrypto.sign rejected.
    reason: Schema.Literal("key-load", "subtle-sign"),
    cause: Schema.Unknown,
  },
) {}

export class StsAssumeRoleFailed extends Schema.TaggedError<StsAssumeRoleFailed>()(
  "StsAssumeRoleFailed",
  {
    provider: Schema.Literal("aws", "gcp", "azure", "other"),
    status: Schema.Number,
    reason: Schema.Literal(
      "mistrusted-issuer",
      "role-mismatch",
      "audience-mismatch",
      "other",
    ),
  },
) {}

/**
 * A `spawnChildRun` could not instantiate a child Workflow instance. Carries
 * the child `run` name and the semantic `instanceId` the spawn targeted so a
 * fan-out parent can report which shard failed to launch. A duplicate
 * instance id is NOT this error — it resolves to `created: false`; this fires
 * only when the platform `create({id})` call itself rejected for another
 * reason (binding missing, rate limit, transport).
 */
export class ChildSpawnFailed extends Schema.TaggedError<ChildSpawnFailed>()(
  "ChildSpawnFailed",
  {
    run: Schema.String,
    instanceId: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * A `waitForChildren` join exceeded its overall wait ceiling with children
 * still pending. Carries the execution ids that had not reached a terminal
 * status and the total time waited, so a fan-out parent can report which shards
 * hung. Distinct from a child that finished `failure` — that is a terminal
 * status the join returns normally; this fires only when children never settle.
 */
export class ChildWaitTimeout extends Schema.TaggedError<ChildWaitTimeout>()(
  "ChildWaitTimeout",
  {
    pending: Schema.Array(Schema.String),
    waitedMs: Schema.Number,
  },
) {}

/** The closed union of every error a run can fail with. */
export type RunError =
  | CheckoutFailed
  | ExecFailed
  | ExecTimeout
  | AcceptanceFailed
  | ContainerLaunchFailed
  | PortNeverOpened
  | ExposePortFailed
  | BrowserUnavailable
  | CacheError
  | ArtifactUploadFailed
  | StepFailed
  | ApprovalTimedOut
  | EventPayloadInvalid
  | SecretsMissing
  | GitHubApiError
  | CloudflareApiError
  | OidcSigningFailed
  | StsAssumeRoleFailed
  | ChildSpawnFailed
  | ChildWaitTimeout;
