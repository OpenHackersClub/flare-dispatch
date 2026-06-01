// chat/completions transport tests — request shape + response mapping.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  buildChatBody,
  chatCompletion,
  chatCompletionsUrl,
  type ChatRequest,
} from "./chat.js";

const baseReq: ChatRequest = {
  baseUrl: "https://gw.example/v1/acct/gw/compat",
  apiKey: "sk-test",
  model: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  systemPrompt: "you are a reviewer",
  userMessage: "review this",
  maxTokens: 2048,
  backend: "opencode",
};

describe("chatCompletionsUrl", () => {
  it("appends /chat/completions, tolerating a trailing slash", () => {
    expect(chatCompletionsUrl("https://x/compat")).toBe(
      "https://x/compat/chat/completions",
    );
    expect(chatCompletionsUrl("https://x/compat/")).toBe(
      "https://x/compat/chat/completions",
    );
  });
});

describe("buildChatBody", () => {
  it("json mode (no tools) — model + system/user messages + max_tokens, NO tools", () => {
    const body = buildChatBody(baseReq);
    expect(body.model).toBe(baseReq.model);
    expect(body.messages).toEqual([
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
    ]);
    expect(body.max_tokens).toBe(2048);
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("tools mode — includes tools + tool_choice:required", () => {
    const tool = {
      type: "function" as const,
      function: { name: "report", description: "d", parameters: { type: "object" } },
    };
    const body = buildChatBody({ ...baseReq, tools: [tool], temperature: 0.2 });
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toBe("required");
    expect(body.temperature).toBe(0.2);
  });
});

// --- Round-trip through a request-capturing stub HttpClient -----------------

const captureClient = (
  responseJson: unknown,
  status = 200,
): { client: HttpClient.HttpClient; seen: { url?: string; auth?: string; body?: unknown } } => {
  const seen: { url?: string; auth?: string; body?: unknown } = {};
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      seen.url = request.url;
      seen.auth = request.headers["authorization"];
      // The body is an `HttpBody` Uint8Array — decode it back to JSON.
      const b = request.body as { _tag: string; body?: Uint8Array };
      if (b._tag === "Uint8Array" && b.body) {
        seen.body = JSON.parse(new TextDecoder().decode(b.body));
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(responseJson), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return { client, seen };
};

describe("chatCompletion (round-trip)", () => {
  it("POSTs to ${baseUrl}/chat/completions with Bearer auth + the built body", async () => {
    const tool = {
      type: "function" as const,
      function: { name: "report", description: "d", parameters: { type: "object" } },
    };
    const { client, seen } = captureClient({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ function: { name: "report", arguments: '{"findings":[]}' } }],
          },
        },
      ],
    });

    const result = await Effect.runPromise(
      chatCompletion({ ...baseReq, tools: [tool] }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );

    expect(seen.url).toBe(
      "https://gw.example/v1/acct/gw/compat/chat/completions",
    );
    expect(seen.auth).toBe("Bearer sk-test");
    expect((seen.body as { tool_choice: string }).tool_choice).toBe("required");
    expect(result.toolCalls).toEqual([
      { name: "report", arguments: '{"findings":[]}' },
    ]);
  });

  it("reads message.content in json mode", async () => {
    const { client } = captureClient({
      choices: [{ message: { content: "hello world" } }],
    });
    const result = await Effect.runPromise(
      chatCompletion(baseReq).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );
    expect(result.content).toBe("hello world");
    expect(result.toolCalls).toEqual([]);
  });

  it("fails ModelCallFailed on a non-2xx", async () => {
    const { client } = captureClient(
      { error: "Compatibility endpoint: responses is not supported." },
      400,
    );
    const exit = await Effect.runPromiseExit(
      chatCompletion(baseReq).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails ModelCallFailed when the response has no choices", async () => {
    const { client } = captureClient({ choices: [] });
    const exit = await Effect.runPromiseExit(
      chatCompletion(baseReq).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
