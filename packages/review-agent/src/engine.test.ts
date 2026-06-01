// Engine unit tests — the model-calling reviewers + the pure risk heuristic.
//
// The model transport (`/chat/completions` over `HttpClient`) is replaced by a
// stub `HttpClient` Layer whose responses are canned `/chat/completions` JSON.
// So these run with no model provider configured. `chatResponse` builds the
// tools/json/empty/error variants; `stubHttp`/`stubHttpSequence` wire them.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { coordinate, classifyRisk, reviewDomain, riskTier } from "./engine.js";
import type { Finding } from "./schemas.js";

// --- chat/completions response fixtures -------------------------------------

/** A tools-mode response: one tool call whose `arguments` is a JSON string. */
const toolsResponse = (name: string, args: unknown): unknown => ({
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          { function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});

/** An empty-tool-calls response (the DeepSeek-via-AI-Gateway pathology). */
const emptyToolsResponse = (content = ""): unknown => ({
  choices: [{ message: { content, tool_calls: [] } }],
});

/** A json-mode response: free-form `message.content` (may contain <think>). */
const textResponse = (content: string): unknown => ({
  choices: [{ message: { content } }],
});

// --- HttpClient stubs --------------------------------------------------------

/** A stub `HttpClient` Layer returning a fixed JSON body + status. */
const stubHttp = (
  json: unknown,
  status = 200,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(json), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    ),
  );

/**
 * A stub `HttpClient` Layer returning a *different* JSON body per call — for the
 * tools→json auto-fallback (first call returns empty tool_calls, retry returns
 * text). `calls()` reports how many requests were issued.
 */
const stubHttpSequence = (
  bodies: ReadonlyArray<unknown>,
): { layer: Layer.Layer<HttpClient.HttpClient>; calls: () => number } => {
  let i = 0;
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = bodies[Math.min(i, bodies.length - 1)];
        i += 1;
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    ),
  );
  return { layer, calls: () => i };
};

/** Common backend coordinates every call needs. */
const conn = {
  baseUrl: "https://gw.example/v1/acct/gw/compat",
  apiKey: "sk-test",
} as const;

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

  it("tools mode — returns findings from the `report` tool call", async () => {
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        tier: "full",
        model: "llama-3.3-70b",
        backend: "opencode",
        mode: "tools",
      }).pipe(
        Effect.provide(stubHttp(toolsResponse("report", { findings: [finding] }))),
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
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubHttp(textResponse(text)))),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — accepts a bare JSON object with no fences", async () => {
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "trivial",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubHttp(textResponse('{"findings":[]}')))),
    );
    expect(result).toEqual([]);
  });

  it("json mode — fails StructuredOutputInvalid on schema mismatch", async () => {
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(
        // `level` is not in the allowed set → schema mismatch after parse.
        Effect.provide(
          stubHttp(
            textResponse(
              '{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}',
            ),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("tools mode — auto-falls-back to json when tool_calls come back empty", async () => {
    // First call (tools) → empty tool_calls (DeepSeek pathology); the engine
    // retries once in json mode, which returns parseable <think>-wrapped text.
    const seq = stubHttpSequence([
      emptyToolsResponse("<think>I won't use tools</think>"),
      textResponse(JSON.stringify({ findings: [finding] })),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "tools",
      }).pipe(Effect.provide(seq.layer)),
    );
    expect(result).toEqual([finding]);
    expect(seq.calls()).toBe(2); // tools attempt + json fallback
  });

  it("fails ModelCallFailed on a non-2xx response", async () => {
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "m",
        backend: "opencode",
        mode: "json",
      }).pipe(
        Effect.provide(stubHttp({ error: "compat: responses not supported" }, 400)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("coordinate", () => {
  it("tools mode — returns the consolidated verdict from the tool call", async () => {
    const verdict = {
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
        ...conn,
        findings: [],
        model: "llama-3.3-70b",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(stubHttp(toolsResponse("verdict", verdict)))),
    );
    expect(result.verdict).toBe("request-changes");
    expect(result.critical).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it("returns exactly what the coordinator emits (dedup is the model's job)", async () => {
    const dup: Finding = {
      path: "src/a.ts",
      startLine: 2,
      endLine: 2,
      level: "warning",
      title: "dup",
      message: "same issue twice",
    };
    const verdict = {
      verdict: "comment",
      critical: 0,
      warnings: 1,
      suggestions: 0,
      findings: [dup],
    };
    const result = await Effect.runPromise(
      coordinate({
        ...conn,
        findings: [dup, dup],
        model: "llama-3.3-70b",
        backend: "opencode",
        mode: "tools",
      }).pipe(Effect.provide(stubHttp(toolsResponse("verdict", verdict)))),
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
        ...conn,
        findings: [],
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(Effect.provide(stubHttp(textResponse(text)))),
    );
    expect(result.verdict).toBe("approve");
    expect(result.suggestions).toBe(1);
  });

  it("tools mode — auto-falls-back to json when tool_calls come back empty", async () => {
    const verdict = {
      verdict: "comment",
      critical: 0,
      warnings: 1,
      suggestions: 0,
      findings: [],
    };
    const seq = stubHttpSequence([
      emptyToolsResponse(),
      textResponse("```json\n" + JSON.stringify(verdict) + "\n```"),
    ]);
    const result = await Effect.runPromise(
      coordinate({
        ...conn,
        findings: [],
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "tools",
      }).pipe(Effect.provide(seq.layer)),
    );
    expect(result.verdict).toBe("comment");
    expect(seq.calls()).toBe(2);
  });

  it("json mode — fails StructuredOutputInvalid when no JSON is present", async () => {
    const exit = await Effect.runPromiseExit(
      coordinate({
        ...conn,
        findings: [],
        model: "deepseek-r1",
        backend: "reasonix",
        mode: "json",
      }).pipe(
        Effect.provide(
          stubHttp(textResponse("<think>I cannot decide</think> sorry, no JSON here")),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
