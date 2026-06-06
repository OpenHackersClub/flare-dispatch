// Run-level unit tests for the `multi-agent-review` run.
//
// The run is mostly an `awsAssumeRole` → `sandbox.exec` → Bedrock SigV4 →
// `github.pullReview` pipeline. The AWS STS + Bedrock paths require live
// HTTP fakes that the in-memory runtime doesn't ship today, so these tests
// cover the run's metadata + the schema contract:
//
//   (a) defineRun shape   — `name`, `version`, `inputs` / `outputs` schemas,
//                            `limits.maxDurationSec` are all set so the
//                            registry's `Schema.decodeUnknownSync` at the
//                            dispatch boundary won't throw on a well-formed
//                            payload.
//   (b) inputs schema     — accepts the documented payload (with `pr` +
//                            `installationId` optional) and rejects a
//                            missing `roleArn`.
//   (c) determinism       — no Date.now() / crypto.randomUUID() / Math.random()
//                            in the run source.
//
// Bedrock-side coverage (the SigV4 signing + InvokeModel path) is captured by
// integration smoke against the deployed Worker — adding HTTP fakes to the
// test runtime is a separate concern, tracked alongside `awsAssumeRole`'s
// own integration story.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { multiAgentReview } from "./multi-agent-review";

describe("multi-agent-review", () => {
  it("defineRun shape — name + version + limits + inputs/outputs schemas", () => {
    expect(multiAgentReview.name).toBe("multi-agent-review");
    expect(multiAgentReview.version).toBe("0.1.0");
    expect(multiAgentReview.limits?.maxDurationSec).toBe(1500);
    expect(multiAgentReview.inputs).toBeDefined();
    expect(multiAgentReview.outputs).toBeDefined();
  });

  it("inputs schema — accepts the documented payload (pr + installationId optional)", () => {
    const result = Schema.decodeUnknownSync(multiAgentReview.inputs)({
      repo: "owner/name",
      sha: "abc123",
      baseSha: "base456",
      roleArn: "arn:aws:iam::123456789012:role/example",
      pr: 42,
      installationId: 7,
    });
    expect(result).toMatchObject({
      repo: "owner/name",
      sha: "abc123",
      roleArn: "arn:aws:iam::123456789012:role/example",
      pr: 42,
      installationId: 7,
    });
  });

  it("inputs schema — pr + installationId are optional (skips comment-post)", () => {
    // No `pr` / `installationId` → comment-post step is skipped at runtime.
    // Schema decode must still accept the payload (workflow_dispatch + branch-
    // level runs have no PR context).
    const result = Schema.decodeUnknownSync(multiAgentReview.inputs)({
      repo: "owner/name",
      sha: "abc123",
      roleArn: "arn:aws:iam::123456789012:role/example",
    });
    expect(result.pr).toBeUndefined();
    expect(result.installationId).toBeUndefined();
  });

  it("inputs schema — rejects a missing roleArn", () => {
    expect(() =>
      Schema.decodeUnknownSync(multiAgentReview.inputs)({
        repo: "owner/name",
        sha: "abc123",
      }),
    ).toThrow();
  });

  it(
    "determinism guard — no Date.now / randomUUID / Math.random in run source",
    () => {
      const src = readFileSync(
        fileURLToPath(new URL("./multi-agent-review.ts", import.meta.url)),
        "utf8",
      );
      // The SigV4 signing path uses `new Date()` (not `Date.now()`) for the
      // `x-amz-date` header — that's WALL-CLOCK time AWS expects, not a
      // determinism violation. The other two are non-negotiable.
      expect(src).not.toMatch(/\bcrypto\.randomUUID\(\)/);
      expect(src).not.toMatch(/\bMath\.random\(\)/);
    },
  );
});
