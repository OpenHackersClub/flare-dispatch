// ModelGatewayLive tests — the Workers AI binding mapping.
//
// Stubs the `AiBinding` with a plain object that records the `run` call and
// returns canned `AiTextGenerationOutput`, then asserts the Layer maps it onto
// the `ModelGateway` contract: messages built from system+user, tools forwarded
// in the Workers-AI shape, gateway id passed through, and tool_calls / response
// mapped to `{ toolCalls, text }`. A thrown `run` → `ModelGatewayError`.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  type ModelCompletionRequest,
  modelGateway,
} from "@flare-dispatch/core";
import { type AiBinding, makeModelGatewayLive } from "./model-gateway-cf";

/** A recording `Ai` stub returning a fixed output. */
const stubAi = (
  output: { response?: string; tool_calls?: Array<{ name: string; arguments: unknown }> },
): {
  ai: AiBinding;
  seen: { model?: string; inputs?: unknown; options?: unknown };
} => {
  const seen: { model?: string; inputs?: unknown; options?: unknown } = {};
  const ai: AiBinding = {
    run: (model, inputs, options) => {
      seen.model = model;
      seen.inputs = inputs;
      seen.options = options;
      return Promise.resolve(output);
    },
  };
  return { ai, seen };
};

const run = (
  ai: AiBinding,
  gatewayId: string | undefined,
  req: ModelCompletionRequest,
) =>
  Effect.runPromise(
    modelGateway
      .complete(req)
      .pipe(Effect.provide(makeModelGatewayLive(ai, gatewayId))),
  );

describe("makeModelGatewayLive", () => {
  it("maps a tool_calls response (object arguments) to toolCalls", async () => {
    const { ai, seen } = stubAi({
      tool_calls: [{ name: "report", arguments: { findings: [] } }],
    });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "you are a reviewer",
      user: "review this",
      maxTokens: 2048,
      tools: [
        { name: "report", description: "d", parameters: { type: "object" } },
      ],
    });

    expect(result.toolCalls).toEqual([
      { name: "report", arguments: { findings: [] } },
    ]);
    expect(result.text).toBe("");

    // The model id passes through verbatim (bare @cf/...).
    expect(seen.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // system + user are built into the messages array.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
    ]);
    // tools are forwarded in the Workers-AI function-tool shape.
    expect((seen.inputs as { tools: unknown }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "report",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ]);
    expect((seen.inputs as { max_tokens: number }).max_tokens).toBe(2048);
    // No gateway id → no options.
    expect(seen.options).toBeUndefined();
  });

  it("maps a text response to `text` and sends no tools in json mode", async () => {
    const { ai, seen } = stubAi({ response: "hello world" });
    const result = await run(ai, undefined, {
      model: "m",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe("hello world");
    expect(result.toolCalls).toEqual([]);
    expect("tools" in (seen.inputs as object)).toBe(false);
  });

  it("passes the AI Gateway id through as { gateway: { id } }", async () => {
    const { ai, seen } = stubAi({ response: "ok" });
    await run(ai, "numu-staging", { model: "m", system: "s", user: "u" });
    expect(seen.options).toEqual({ gateway: { id: "numu-staging" } });
  });

  it("fails ModelGatewayError when the binding throws", async () => {
    const ai: AiBinding = {
      run: () => Promise.reject(new Error("429 Too Many Requests")),
    };
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "m", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
