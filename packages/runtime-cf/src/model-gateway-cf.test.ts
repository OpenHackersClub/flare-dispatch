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

// ---------------------------------------------------------------------------
// The anthropic/* universal route.

/** A recording gateway stub returning a fixed Anthropic Messages response. */
const stubGatewayAi = (
  body: unknown,
  status = 200,
): {
  ai: AiBinding;
  seen: { gatewayId?: string; request?: Record<string, unknown> };
} => {
  const seen: { gatewayId?: string; request?: Record<string, unknown> } = {};
  const ai: AiBinding = {
    run: () => Promise.reject(new Error("workers-ai route must not be used")),
    gateway: (gatewayId) => {
      seen.gatewayId = gatewayId;
      return {
        run: (data) => {
          seen.request = data as unknown as Record<string, unknown>;
          return Promise.resolve(
            new Response(JSON.stringify(body), { status }),
          );
        },
      };
    },
  };
  return { ai, seen };
};

describe("makeModelGatewayLive — anthropic universal route", () => {
  it("routes anthropic/* through gateway.run and maps tool_use blocks", async () => {
    const { ai, seen } = stubGatewayAi({
      content: [
        { type: "text", text: "thinking…" },
        { type: "tool_use", name: "report", input: { findings: [] } },
      ],
    });
    const result = await run(ai, "my-gateway", {
      model: "anthropic/claude-sonnet-4-6",
      system: "you are a reviewer",
      user: "review this",
      maxTokens: 1024,
      tools: [
        { name: "report", description: "d", parameters: { type: "object" } },
      ],
    });

    expect(result.toolCalls).toEqual([
      { name: "report", arguments: { findings: [] } },
    ]);
    expect(result.text).toBe("thinking…");

    expect(seen.gatewayId).toBe("my-gateway");
    expect(seen.request?.provider).toBe("anthropic");
    expect(seen.request?.endpoint).toBe("v1/messages");
    const query = seen.request?.query as Record<string, unknown>;
    // The `anthropic/` prefix is stripped — the provider gets its own naming.
    expect(query.model).toBe("claude-sonnet-4-6");
    expect(query.system).toBe("you are a reviewer");
    expect(query.messages).toEqual([{ role: "user", content: "review this" }]);
    expect(query.max_tokens).toBe(1024);
    // Tools map to Anthropic's input_schema shape with forced tool use.
    expect(query.tools).toEqual([
      { name: "report", description: "d", input_schema: { type: "object" } },
    ]);
    expect(query.tool_choice).toEqual({ type: "any" });
  });

  it("concatenates text blocks when no tools are sent (json mode)", async () => {
    const { ai, seen } = stubGatewayAi({
      content: [
        { type: "text", text: '{"findings"' },
        { type: "text", text: ":[]}" },
      ],
    });
    const result = await run(ai, "g", {
      model: "anthropic/claude-haiku-4-5",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
    const query = seen.request?.query as Record<string, unknown>;
    expect("tools" in query).toBe(false);
    // Anthropic requires max_tokens — defaulted when the caller didn't set one.
    expect(query.max_tokens).toBe(2048);
  });

  it("maps a non-2xx provider response to ModelGatewayError by status", async () => {
    const { ai } = stubGatewayAi({ error: { message: "overloaded" } }, 429);
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "anthropic/claude-sonnet-4-6", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, "g"))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails with an operator-facing error when no gateway id is configured", async () => {
    const { ai } = stubGatewayAi({ content: [] });
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "anthropic/claude-sonnet-4-6", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
