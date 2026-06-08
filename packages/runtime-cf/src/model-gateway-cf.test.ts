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
    // Workers AI chat templates drop the system message when tools are present
    // — on the tools path the system instruction is folded into the user turn.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "user", content: "you are a reviewer\n\nreview this" },
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
    // No tools → the template honours the system role; keep it separate.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
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

  it("coerces a non-string `response` (some catalog models return parsed objects) to JSON text", async () => {
    // Some Workers AI models occasionally return `response` as a parsed
    // object instead of a string. Without coercion here, the downstream
    // engine's parseStructured fires `StructuredOutputInvalid: got object`
    // — a generic-sounding error that obscures the cause. The route must
    // hand parseStructured a string so it has something concrete to
    // JSON.parse + Schema-decode.
    const { ai } = stubAi({
      response: { findings: [] } as unknown as string,
    });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(typeof result.text).toBe("string");
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
  });

  it("coerces a missing `response` to empty string (back-compat)", async () => {
    const { ai } = stubAi({});
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe("");
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
    // Anthropic rejects a Messages call without its API version pin.
    expect(
      (seen.request?.headers as Record<string, string>)["anthropic-version"],
    ).toBe("2023-06-01");
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

// --- The Bedrock-via-AI-Gateway route ---------------------------------------

describe("makeModelGatewayLive — bedrock-via-AI-Gateway route", () => {
  /** A `fetch` stub that records the URL + headers + body and returns canned JSON. */
  const stubFetch = (
    payload: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } = {
      content: [{ type: "text", text: "review body" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ): {
    fetchImpl: typeof fetch;
    seen: { url?: string; headers?: Record<string, string>; body?: string };
  } => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  };

  // Smuggle the fetch stub into the Bedrock route by monkey-patching globalThis.fetch
  // for the duration of one test. The shared helper defaults to the global fetch.
  const withFetch = async <T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    try {
      return await fn();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = original;
    }
  };

  // Cast through unknown — the AiBinding stub doesn't matter on the bedrock route
  // (it's bypassed entirely), but the Layer factory still needs a value.
  const inertAi = ({} as unknown) as AiBinding;

  const awsCreds = {
    accessKeyId: "AKIA-TEST",
    secretAccessKey: "secret-test",
    sessionToken: "session-token-test",
    region: "us-east-1",
  };

  it("routes through the AI Gateway Bedrock URL with the AWS hostname signed", async () => {
    const { fetchImpl, seen } = stubFetch();
    const result = await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "you are a reviewer",
            user: "review this",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", "acct123"))),
      ),
    );

    // URL pinned to the AI Gateway forwarder
    expect(seen.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/g/aws-bedrock/bedrock-runtime/us-east-1/model/us.anthropic.claude-opus-4-6-v1/invoke",
    );
    // SigV4 signs against the AWS hostname (host header), not the gateway
    expect(seen.headers!.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(seen.headers!.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA-TEST/);
    // x-amz-security-token forwards the STS session token
    expect(seen.headers!["x-amz-security-token"]).toBe("session-token-test");
    // Body shape is Anthropic-on-Bedrock with the version pin
    const body = JSON.parse(seen.body!) as {
      anthropic_version: string;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.system).toBe("you are a reviewer");
    expect(body.messages).toEqual([{ role: "user", content: "review this" }]);

    // Response mapped to {text, toolCalls:[], inputTokens, outputTokens}
    expect(result.text).toBe("review body");
    expect(result.toolCalls).toEqual([]);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("forwards cf-aig-authorization when an auth token is configured", async () => {
    const { fetchImpl, seen } = stubFetch();
    await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(
            Effect.provide(
              makeModelGatewayLive(inertAi, "g", "acct123", "secret-bearer"),
            ),
          ),
      ),
    );
    expect(seen.headers!["cf-aig-authorization"]).toBe("Bearer secret-bearer");
  });

  it("fails with an operator-facing error when req.aws is missing", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", "acct123"))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails when CLOUDFLARE_ACCOUNT_ID is not configured", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", undefined))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails when AI_GATEWAY_ID is not configured", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, undefined, "acct123"))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
