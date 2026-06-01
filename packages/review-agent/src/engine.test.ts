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
// response carrying scripted `toolCalls` — the seam demo-agent's play.test uses.
const stubModel = (
  toolCalls: ReadonlyArray<{ name: string; params: unknown }>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () => Effect.succeed({ toolCalls, text: "" } as never),
  } as unknown as LanguageModel.Service);

/** A stub whose `generateText` returns free-form text (no tool calls) — json mode. */
const stubTextModel = (
  text: string,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () => Effect.succeed({ toolCalls: [], text } as never),
  } as unknown as LanguageModel.Service);

/**
 * A stub that returns a *different* response per call — for the tools→json
 * auto-fallback: first call (tools) returns empty tool_calls, the retry (json)
 * returns text. The engine cannot pass tools to the json retry, so we key on
 * call order, not on the request shape.
 */
const stubSequence = (
  responses: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string; params: unknown }>; text?: string }>,
): { layer: Layer.Layer<LanguageModel.LanguageModel>; calls: () => number } => {
  let i = 0;
  const layer = Layer.succeed(LanguageModel.LanguageModel, {
    generateText: () =>
      Effect.sync(() => {
        const r = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return { toolCalls: r.toolCalls ?? [], text: r.text ?? "" } as never;
      }),
  } as unknown as LanguageModel.Service);
  return { layer, calls: () => i };
};

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

  it("json mode — parses a <think>-wrapped, code-fenced JSON response", async () => {
    const text = [
      "<think>",
      "The diff adds an unchecked input, I should flag it as a warning.",
      "</think>",
      "```json",
      JSON.stringify({ findings: [finding] }),
      "```",
    ].join("\n");

    const result = await Effect.runPromise(
      reviewDomain({
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubTextModel(text))),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — accepts a bare JSON object with no fences", async () => {
    const result = await Effect.runPromise(
      reviewDomain({
        agent: "security",
        diff: "x",
        tier: "trivial",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubTextModel('{"findings":[]}'))),
    );
    expect(result).toEqual([]);
  });

  it("json mode — fails StructuredOutputInvalid on non-JSON / schema mismatch", async () => {
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(
        // `level` is not in the allowed set → schema mismatch after parse.
        Effect.provide(
          stubTextModel('{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}'),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("tools mode — auto-falls-back to json when the model returns no tool call", async () => {
    // First call (tools) returns zero tool_calls (the DeepSeek pathology);
    // the engine retries once in json mode, which returns parseable text.
    const seq = stubSequence([
      { toolCalls: [] },
      { text: JSON.stringify({ findings: [finding] }) },
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "test-model",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(seq.layer)),
    );
    expect(result).toEqual([finding]);
    expect(seq.calls()).toBe(2); // tools attempt + json fallback
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

  it("json mode — parses a <think>-wrapped coordinator verdict", async () => {
    const verdict = {
      verdict: "approve",
      critical: 0,
      warnings: 0,
      suggestions: 1,
      findings: [],
    };
    const text = [
      "<think>two findings collapse to none after dedup</think>",
      JSON.stringify(verdict),
    ].join("\n");

    const result = await Effect.runPromise(
      coordinate({
        findings: [],
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubTextModel(text))),
    );
    expect(result.verdict).toBe("approve");
    expect(result.suggestions).toBe(1);
  });

  it("tools mode — auto-falls-back to json when the coordinator returns no tool call", async () => {
    const verdict = {
      verdict: "comment",
      critical: 0,
      warnings: 1,
      suggestions: 0,
      findings: [],
    };
    const seq = stubSequence([
      { toolCalls: [] },
      { text: "```json\n" + JSON.stringify(verdict) + "\n```" },
    ]);
    const result = await Effect.runPromise(
      coordinate({
        findings: [],
        model: "test-model",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(seq.layer)),
    );
    expect(result.verdict).toBe("comment");
    expect(seq.calls()).toBe(2);
  });

  it("json mode — fails StructuredOutputInvalid when no JSON is present", async () => {
    const exit = await Effect.runPromiseExit(
      coordinate({
        findings: [],
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(
        Effect.provide(stubTextModel("<think>I cannot decide</think> sorry, no JSON here")),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
