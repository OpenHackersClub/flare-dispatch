// Engine unit tests — the model-calling reviewers + the pure risk heuristic.
//
// The real `LanguageModel` is replaced by a stub Layer whose `generateText`
// returns a canned response carrying scripted `toolCalls` — exactly the seam
// demo-agent's play.test uses. So these run with no model provider configured.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { LanguageModel } from "@effect/ai";
import {
  classifyRisk,
  coordinate,
  reviewDomain,
  riskTier,
} from "./engine.js";
import type { Finding } from "./schemas.js";

// A stub `LanguageModel` whose `generateText` ignores its prompt and returns a
// response with the scripted tool calls. Only the fields the engine reads
// (`toolCalls`) are populated.
const stubModel = (
  toolCalls: ReadonlyArray<{ name: string; params: unknown }>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () => Effect.succeed({ toolCalls } as never),
  } as unknown as LanguageModel.Service);

describe("riskTier / classifyRisk", () => {
  it("an empty diff is trivial", () => {
    expect(classifyRisk("")).toBe("trivial");
  });

  it("a tiny diff is trivial", () => {
    const diff = [
      "diff --git a/src/util.ts b/src/util.ts",
      "--- a/src/util.ts",
      "+++ b/src/util.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    expect(classifyRisk(diff)).toBe("trivial");
  });

  it("a medium diff is lite", () => {
    const body = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join("\n");
    const diff = [
      "diff --git a/src/big.ts b/src/big.ts",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,1 +1,60 @@",
      body,
    ].join("\n");
    expect(classifyRisk(diff)).toBe("lite");
  });

  it("a large diff is full", () => {
    const body = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join("\n");
    const diff = [
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      "@@ @@",
      body,
    ].join("\n");
    expect(classifyRisk(diff)).toBe("full");
  });

  it("a sensitive path escalates a one-line change to full", () => {
    const diff = [
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -1,1 +1,1 @@",
      "-runs-on: ubuntu-22.04",
      "+runs-on: ubuntu-24.04",
    ].join("\n");
    expect(classifyRisk(diff)).toBe("full");
  });

  it("riskTier is the Effect wrapper of classifyRisk", async () => {
    const tier = await Effect.runPromise(riskTier({ diff: "" }));
    expect(tier).toBe("trivial");
  });
});

describe("reviewDomain", () => {
  const finding: Finding = {
    path: "src/a.ts",
    startLine: 3,
    endLine: 5,
    level: "warning",
    title: "unchecked input",
    message: "validate before use",
  };

  it("returns the findings the model reports via the tool call", async () => {
    const result = await Effect.runPromise(
      reviewDomain({
        agent: "security",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        tier: "full",
        model: "test-model",
        backend: "opencode",
      }).pipe(
        Effect.provide(stubModel([{ name: "report", params: { findings: [finding] } }])),
      ),
    );
    expect(result).toEqual([finding]);
  });

  it("fails with bad-response when the model returns no tool call", async () => {
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "test-model",
        backend: "reasonix",
      }).pipe(Effect.provide(stubModel([]))),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("coordinate", () => {
  it("returns the consolidated verdict the model emits", async () => {
    const params = {
      verdict: "request-changes",
      critical: 1,
      warnings: 0,
      suggestions: 0,
      findings: [
        {
          path: "src/a.ts",
          startLine: 1,
          endLine: 1,
          level: "failure",
          title: "sql injection",
          message: "parameterize the query",
        },
      ],
    };
    const result = await Effect.runPromise(
      coordinate({
        findings: [],
        model: "test-model",
        backend: "opencode",
      }).pipe(
        Effect.provide(stubModel([{ name: "verdict", params }])),
      ),
    );
    expect(result.verdict).toBe("request-changes");
    expect(result.critical).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it("a coordinator that dedups two identical findings into one is honored", async () => {
    // The dedup is the model's job; the engine faithfully returns what the
    // coordinator emits. Here the stub emits one finding from two inputs.
    const dup: Finding = {
      path: "src/a.ts",
      startLine: 2,
      endLine: 2,
      level: "warning",
      title: "dup",
      message: "same issue twice",
    };
    const params = {
      verdict: "comment",
      critical: 0,
      warnings: 1,
      suggestions: 0,
      findings: [dup],
    };
    const result = await Effect.runPromise(
      coordinate({
        findings: [dup, dup],
        model: "test-model",
        backend: "opencode",
      }).pipe(Effect.provide(stubModel([{ name: "verdict", params }]))),
    );
    expect(result.findings).toHaveLength(1);
  });

  it("fails when the coordinator returns no tool call", async () => {
    const exit = await Effect.runPromiseExit(
      coordinate({
        findings: [],
        model: "test-model",
        backend: "opencode",
      }).pipe(Effect.provide(stubModel([]))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
