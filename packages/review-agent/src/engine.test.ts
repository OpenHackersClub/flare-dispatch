// Engine unit tests.
//
//   * `reviewDomain` calls the model — the `/chat/completions` transport is
//     replaced by a stub `HttpClient` Layer (`stubHttp`/`stubHttpSequence`)
//     returning canned response JSON, so these run with no provider configured.
//   * `coordinate` / `riskTier` are PURE — tested directly, no stub.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  classifyRisk,
  coordinate,
  coordinateReview,
  reviewDomain,
  riskTier,
} from "./engine.js";
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

  it("folds previous findings in, deduping ones still re-raised this run", () => {
    const current = mk({ path: "a.ts", startLine: 1, title: "open", level: "warning" });
    const stillOpenInPrev = mk({ path: "a.ts", startLine: 1, title: "open", level: "warning" });
    const onlyInPrev = mk({ path: "z.ts", startLine: 3, title: "old", level: "notice" });
    const r = coordinateReview({
      findings: [current],
      previous: {
        verdict: "comment",
        tier: "full",
        critical: 0,
        warnings: 1,
        suggestions: 1,
        findings: [stillOpenInPrev, onlyInPrev],
      },
    });
    // current "open" (deduped against prev) + prev-only "old" = 2.
    expect(r.findings).toHaveLength(2);
    expect(r.warnings).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(r.verdict).toBe("comment");
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
