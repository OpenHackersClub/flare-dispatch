// JSON-extraction unit tests — the reasoning-model text → JSON pipeline.

import { describe, expect, it } from "vitest";
import {
  extractJsonText,
  stripCodeFences,
  stripThinkBlocks,
} from "./json-extract.js";

describe("stripThinkBlocks", () => {
  it("removes a complete <think>…</think> block", () => {
    expect(stripThinkBlocks("<think>reasoning</think>{\"a\":1}").trim()).toBe(
      '{"a":1}',
    );
  });

  it("removes an unterminated <think> opener (truncated output)", () => {
    expect(stripThinkBlocks("ok\n<think>still thinking...").trim()).toBe("ok");
  });

  it("is case-insensitive and multi-line", () => {
    const t = "<THINK>\nline1\nline2\n</THINK>\npayload";
    expect(stripThinkBlocks(t).trim()).toBe("payload");
  });
});

describe("stripCodeFences", () => {
  it("extracts content from a ```json fence", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```').trim()).toBe('{"a":1}');
  });

  it("extracts content from a bare ``` fence", () => {
    expect(stripCodeFences("```\n[1,2]\n```").trim()).toBe("[1,2]");
  });

  it("passes through unfenced text unchanged", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("extractJsonText", () => {
  it("isolates a JSON object from a <think>-wrapped, fenced response", () => {
    const text = [
      "<think>let me reason about this</think>",
      "Here is the result:",
      "```json",
      '{"findings":[{"path":"a.ts"}]}',
      "```",
    ].join("\n");
    expect(extractJsonText(text)).toBe('{"findings":[{"path":"a.ts"}]}');
  });

  it("isolates a bare object with surrounding prose", () => {
    expect(extractJsonText('blah {"x":1} trailing')).toBe('{"x":1}');
  });

  it("ignores braces inside strings when bracket-matching", () => {
    expect(extractJsonText('{"msg":"a } b"}')).toBe('{"msg":"a } b"}');
  });

  it("isolates an array value", () => {
    expect(extractJsonText("result: [1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("returns undefined when no JSON value is present", () => {
    expect(extractJsonText("<think>no json</think> just prose")).toBeUndefined();
  });

  it("returns undefined for empty / whitespace input", () => {
    expect(extractJsonText("")).toBeUndefined();
    expect(extractJsonText("   \n  ")).toBeUndefined();
  });
});
