// Tests for the tagged run errors — exhaustive `Match` over every `RunError`
// variant. The acceptance criterion (specs/pm/plan.md § PR2) is that this
// `Match.exhaustive` *compiles*: adding a `RunError` variant without a branch
// here is a type error.

import { Match } from "effect";
import { describe, expect, it } from "vitest";
import {
  ApprovalTimedOut,
  ArtifactUploadFailed,
  BrowserUnavailable,
  CacheError,
  CheckoutFailed,
  ContainerLaunchFailed,
  EventPayloadInvalid,
  ExecFailed,
  ExecTimeout,
  ExposePortFailed,
  GitHubApiError,
  OidcSigningFailed,
  PortNeverOpened,
  type RunError,
  SecretsMissing,
  StepFailed,
  StsAssumeRoleFailed,
} from "./errors";

/**
 * Summarise any `RunError`. `Match.exhaustive` makes a missing branch a
 * compile error — this function is the live exhaustiveness check.
 */
const summarize = (e: RunError): string =>
  Match.value(e).pipe(
    Match.tag("CheckoutFailed", ({ repo, sha }) => `checkout ${repo}@${sha}`),
    Match.tag("ExecFailed", ({ exitCode }) => `exec exited ${exitCode}`),
    Match.tag("ExecTimeout", ({ timeoutSec }) => `exec timeout ${timeoutSec}s`),
    Match.tag("ContainerLaunchFailed", ({ image }) => `launch ${image}`),
    Match.tag("PortNeverOpened", ({ port }) => `port ${port} never opened`),
    Match.tag("ExposePortFailed", ({ port }) => `expose port ${port} failed`),
    Match.tag("BrowserUnavailable", ({ reason }) => `browser ${reason}`),
    Match.tag("CacheError", ({ phase, key }) => `cache ${phase} ${key}`),
    Match.tag("ArtifactUploadFailed", ({ name }) => `artifact ${name}`),
    Match.tag("StepFailed", ({ step }) => `step ${step}`),
    Match.tag("ApprovalTimedOut", ({ eventName }) => `approval ${eventName}`),
    Match.tag("EventPayloadInvalid", ({ reason }) => `event payload ${reason}`),
    Match.tag("SecretsMissing", ({ keys }) => `secrets missing ${keys.join(",")}`),
    Match.tag("GitHubApiError", ({ status, reason }) => `github ${status} ${reason}`),
    Match.tag("OidcSigningFailed", ({ reason }) => `oidc ${reason}`),
    Match.tag("StsAssumeRoleFailed", ({ provider, reason }) => `sts ${provider} ${reason}`),
    Match.exhaustive,
  );

const samples: ReadonlyArray<{ name: string; err: RunError; expect: string }> =
  [
    {
      name: "CheckoutFailed",
      err: new CheckoutFailed({ repo: "o/n", sha: "abc", cause: "x" }),
      expect: "checkout o/n@abc",
    },
    {
      name: "ExecFailed",
      err: new ExecFailed({ exitCode: 7, stderrTail: "" }),
      expect: "exec exited 7",
    },
    {
      name: "ExecTimeout",
      err: new ExecTimeout({ timeoutSec: 60, command: "pnpm test" }),
      expect: "exec timeout 60s",
    },
    {
      name: "ContainerLaunchFailed",
      err: new ContainerLaunchFailed({ image: "node:lts", cause: "x" }),
      expect: "launch node:lts",
    },
    {
      name: "PortNeverOpened",
      err: new PortNeverOpened({ port: 3000, timeoutSec: 120 }),
      expect: "port 3000 never opened",
    },
    {
      name: "ExposePortFailed",
      err: new ExposePortFailed({ port: 4173, cause: "x" }),
      expect: "expose port 4173 failed",
    },
    {
      name: "BrowserUnavailable",
      err: new BrowserUnavailable({ reason: "transient" }),
      expect: "browser transient",
    },
    {
      name: "CacheError",
      err: new CacheError({ phase: "restore", key: "k", cause: "x" }),
      expect: "cache restore k",
    },
    {
      name: "ArtifactUploadFailed",
      err: new ArtifactUploadFailed({ name: "log", cause: "x" }),
      expect: "artifact log",
    },
    {
      name: "StepFailed",
      err: new StepFailed({ step: "exec", cause: "x" }),
      expect: "step exec",
    },
    {
      name: "ApprovalTimedOut",
      err: new ApprovalTimedOut({ eventName: "release", timeoutMs: 1000 }),
      expect: "approval release",
    },
    {
      name: "EventPayloadInvalid",
      err: new EventPayloadInvalid({ eventName: "release", reason: "bad" }),
      expect: "event payload bad",
    },
    {
      name: "SecretsMissing",
      err: new SecretsMissing({ keys: ["CLERK_SECRET_KEY"] }),
      expect: "secrets missing CLERK_SECRET_KEY",
    },
    {
      name: "GitHubApiError",
      err: new GitHubApiError({ status: 429, reason: "rate-limited" }),
      expect: "github 429 rate-limited",
    },
    {
      name: "OidcSigningFailed",
      err: new OidcSigningFailed({ reason: "key-load", cause: "missing JWK" }),
      expect: "oidc key-load",
    },
    {
      name: "StsAssumeRoleFailed",
      err: new StsAssumeRoleFailed({
        provider: "aws",
        status: 403,
        reason: "role-mismatch",
      }),
      expect: "sts aws role-mismatch",
    },
  ];

describe("RunError — exhaustive Match", () => {
  for (const { name, err, expect: want } of samples) {
    it(`matches ${name}`, () => {
      expect(summarize(err)).toBe(want);
    });
  }

  it("every tagged error carries its `_tag`", () => {
    for (const { name, err } of samples) {
      expect(err._tag).toBe(name);
    }
  });

  it("tagged errors are instances of Error", () => {
    for (const { err } of samples) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
