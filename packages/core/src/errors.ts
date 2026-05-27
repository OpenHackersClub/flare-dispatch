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

export class CacheError extends Schema.TaggedError<CacheError>()(
  "CacheError",
  {
    phase: Schema.Literal("restore", "save"),
    key: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class ArtifactUploadFailed extends Schema.TaggedError<ArtifactUploadFailed>()(
  "ArtifactUploadFailed",
  { name: Schema.String, cause: Schema.Unknown },
) {}

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

/** The closed union of every error a run can fail with. */
export type RunError =
  | CheckoutFailed
  | ExecFailed
  | ExecTimeout
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
  | OidcSigningFailed
  | StsAssumeRoleFailed;
