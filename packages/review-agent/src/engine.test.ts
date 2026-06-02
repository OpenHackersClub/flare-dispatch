// Engine unit tests.
//
//   * `reviewDomain` calls the model — the `modelGateway` capability is replaced
//     by the core `ModelGatewayFake`, scripted with canned `{ toolCalls, text }`
//     results (and `ModelGatewayError` for the failure path), so these run with
//     no provider configured.
//   * `coordinate` / `riskTier` are PURE — tested directly, no fake.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  ModelGateway,
  ModelGatewayError,
  type ModelCompletionResult,
} from "@flare-dispatch/core";
import { makeModelGatewayFake } from "@flare-dispatch/core/testing";
import {
  classifyRisk,
  coordinate,
  coordinateReview,
  reviewDomain,
  riskTier,
} from "./engine.js";
import type { Finding } from "./schemas.js";

// --- ModelGateway result fixtures -------------------------------------------

/** A tools-mode result: one tool call whose `arguments` is a parsed OBJECT
 *  (the Workers AI shape). */
const toolsResult = (name: string, args: unknown): ModelCompletionResult => ({
  toolCalls: [{ name, arguments: args }],
  text: "",
});

/** A tools-mode result whose `arguments` is a JSON STRING (the OpenAI shape). */
const toolsResultString = (
  name: string,
  args: unknown,
): ModelCompletionResult => ({
  toolCalls: [{ name, arguments: JSON.stringify(args) }],
  text: "",
});

/** An empty-tool-calls result (the DeepSeek-via-AI-Gateway pathology). */
const emptyToolsResult = (text = ""): ModelCompletionResult => ({
  toolCalls: [],
  text,
});

/** A json-mode result: free-form `text` (may contain <think>). */
const textResult = (text: string): ModelCompletionResult => ({
  toolCalls: [],
  text,
});

/** Provide a ModelGateway fake scripted with the given responses. */
const withGateway = (
  responses: ReadonlyArray<ModelCompletionResult | ModelGatewayError>,
): { layer: Layer.Layer<ModelGateway>; calls: () => number } => {
  const fake = makeModelGatewayFake({ responses });
  return { layer: fake.layer, calls: () => fake.state.requests.length };
};

/** Common backend coordinates every call needs. */
const conn = { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as const;

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

  it("tools mode — returns findings from the `report` tool call (object args)", async () => {
    const { layer } = withGateway([
      toolsResult("report", { findings: [finding] }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        tier: "full",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("tools mode — also accepts a JSON-STRING `arguments` (OpenAI shape)", async () => {
    const { layer } = withGateway([
      toolsResultString("report", { findings: [finding] }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "full",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("tools mode — coerces a double-encoded `findings` (JSON STRING) back to an array", async () => {
    // Workers AI tool-calling sometimes double-encodes the nested array: the
    // tool `arguments` object carries `findings` as a JSON string ("[{…}]")
    // rather than an array. The engine parses it before Schema-decode.
    const { layer } = withGateway([
      toolsResult("report", { findings: JSON.stringify([finding]) }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "full",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — coerces a double-encoded `findings` (JSON STRING) back to an array", async () => {
    // Same pathology over the json-text path: a valid outer object whose
    // `findings` value is itself a JSON string.
    const { layer } = withGateway([
      textResult(JSON.stringify({ findings: JSON.stringify([finding]) })),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(layer)),
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

    const { layer } = withGateway([textResult(text)]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — accepts a bare JSON object with no fences", async () => {
    const { layer } = withGateway([textResult('{"findings":[]}')]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "trivial",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([]);
  });

  it("json mode — fails StructuredOutputInvalid on schema mismatch", async () => {
    const { layer } = withGateway([
      // `level` is not in the allowed set → schema mismatch after parse.
      textResult(
        '{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}',
      ),
    ]);
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("tools mode — auto-falls-back to json when tool_calls come back empty", async () => {
    // First call (tools) → empty tool_calls (DeepSeek pathology); the engine
    // retries once in json mode, which returns parseable <think>-wrapped text.
    const { layer, calls } = withGateway([
      emptyToolsResult("<think>I won't use tools</think>"),
      textResult(JSON.stringify({ findings: [finding] })),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "reasonix",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
    expect(calls()).toBe(2); // tools attempt + json fallback
  });

  it("fails ModelCallFailed on a gateway error", async () => {
    const { layer } = withGateway([
      new ModelGatewayError({
        model: conn.model,
        reason: "bad-response",
        message: "Workers AI run failed: boom",
      }),
    ]);
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "m",
        backend: "opencode",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("coordinate / coordinateReview (pure — no model call)", () => {
  const mk = (
    over: Partial<Finding> & Pick<Finding, "path" | "startLine" | "title" | "level">,
  ): Finding => ({
    endLine: over.startLine,
    message: "m",
    ...over,
  });

  it("counts by level and approves a clean (notice-only) review", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "style", level: "notice" }),
        mk({ path: "a.ts", startLine: 2, title: "naming", level: "notice" }),
      ],
    });
    expect(r.critical).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.suggestions).toBe(2);
    expect(r.verdict).toBe("approve");
    expect(r.findings).toHaveLength(2);
  });

  it("a warning (no failures) → comment", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "perf", level: "warning" }),
        mk({ path: "a.ts", startLine: 9, title: "doc", level: "notice" }),
      ],
    });
    expect(r.warnings).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(r.verdict).toBe("comment");
  });

  it("any failure → request-changes (bias preserved: only critical blocks)", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "sqli", level: "failure" }),
        mk({ path: "a.ts", startLine: 2, title: "perf", level: "warning" }),
        mk({ path: "a.ts", startLine: 3, title: "style", level: "notice" }),
      ],
    });
    expect(r.critical).toBe(1);
    expect(r.warnings).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(r.verdict).toBe("request-changes");
  });

  it("an empty review approves with zero counts", () => {
    const r = coordinateReview({ findings: [] });
    expect(r).toEqual({
      verdict: "approve",
      critical: 0,
      warnings: 0,
      suggestions: 0,
      findings: [],
    });
  });

  it("dedups by (path, startLine, title), keeping the first occurrence", () => {
    const first = mk({ path: "a.ts", startLine: 5, title: "dup", level: "warning", message: "keep me" });
    const same = mk({ path: "a.ts", startLine: 5, title: "dup", level: "failure", message: "drop me" });
    const r = coordinateReview({ findings: [first, same] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.message).toBe("keep me");
    // The dropped duplicate's level does not inflate the counts.
    expect(r.warnings).toBe(1);
    expect(r.critical).toBe(0);
  });

  it("does NOT dedup findings that differ in path / line / title", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 5, title: "x", level: "notice" }),
        mk({ path: "b.ts", startLine: 5, title: "x", level: "notice" }), // diff path
        mk({ path: "a.ts", startLine: 6, title: "x", level: "notice" }), // diff line
        mk({ path: "a.ts", startLine: 5, title: "y", level: "notice" }), // diff title
      ],
    });
    expect(r.findings).toHaveLength(4);
  });

  it("is authoritative on the current run — a fixed finding clears (no carry-over)", () => {
    // Push 1: a failure finding → request-changes.
    const push1 = coordinateReview({
      findings: [mk({ path: "a.ts", startLine: 1, title: "sqli", level: "failure" })],
    });
    expect(push1.verdict).toBe("request-changes");
    expect(push1.critical).toBe(1);

    // Push 2: the author fixed it, so the reviewers no longer raise it. `coordinate`
    // is stateless — nothing is carried over from push 1 — so the verdict clears.
    const push2 = coordinateReview({ findings: [] });
    expect(push2.verdict).toBe("approve");
    expect(push2.critical).toBe(0);
    expect(push2.findings).toHaveLength(0);
  });

  it("coordinate is the Effect wrapper of coordinateReview and never fails", async () => {
    const findings = [
      mk({ path: "a.ts", startLine: 1, title: "boom", level: "failure" }),
    ];
    const r = await Effect.runPromise(coordinate({ findings }));
    expect(r).toEqual(coordinateReview({ findings }));
    expect(r.verdict).toBe("request-changes");
  });
});
