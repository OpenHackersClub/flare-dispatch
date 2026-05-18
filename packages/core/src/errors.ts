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
  { port: Schema.Number, timeoutSec: Schema.Number },
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

/** The closed union of every error a run can fail with. */
export type RunError =
  | CheckoutFailed
  | ExecFailed
  | ExecTimeout
  | ContainerLaunchFailed
  | PortNeverOpened
  | BrowserUnavailable
  | CacheError
  | ArtifactUploadFailed
  | StepFailed
  | ApprovalTimedOut
  | EventPayloadInvalid;
