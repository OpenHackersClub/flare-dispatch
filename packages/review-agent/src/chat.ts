// @flare-dispatch/review-agent — OpenAI-compatible /chat/completions client.
//
// The engine talks to the model over a direct HTTP POST to
// `${baseUrl}/chat/completions` using `@effect/platform` `HttpClient` (so it
// stays Effect + testable; the run provides `FetchHttpClient.layer`).
//
// WHY NOT @effect/ai-openai: that adapter's `OpenAiLanguageModel` only hits the
// OpenAI `/responses` API. The target — Cloudflare AI Gateway's compat endpoint
// (`base_url = …/<gateway>/compat`) — only supports `/chat/completions`, so
// every `/responses` call 400s ("Compatibility endpoint: responses is not
// supported."). The chat/completions shape below is verified by curl against
// that gateway → Workers AI for both tools and json modes.

import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Effect, Schema } from "effect";
import { ModelCallFailed } from "./errors.js";

/** A `tools`-array entry in the chat/completions request. */
export type ChatTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the function arguments. */
    readonly parameters: unknown;
  };
};

export type ChatRequest = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  /** When present → tools mode: sent with `tool_choice: "required"`. */
  readonly tools?: ReadonlyArray<ChatTool>;
  /** Identity for error reporting. */
  readonly backend: string;
};

/** One tool call the model returned. `arguments` is a JSON STRING. */
export type ChatToolCall = {
  readonly name: string;
  /** Raw JSON string of the function arguments (provider returns a string). */
  readonly arguments: string;
};

/** The slice of a chat/completions response the engine consumes. */
export type ChatResult = {
  /** `choices[0].message.content` — the assistant text (may be empty). */
  readonly content: string;
  /** `choices[0].message.tool_calls` mapped to `{ name, arguments }`. */
  readonly toolCalls: ReadonlyArray<ChatToolCall>;
};

// --- Response schema (the minimal slice we read) ----------------------------

const ToolCallSchema = Schema.Struct({
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

const MessageSchema = Schema.Struct({
  // Workers AI may omit `content` when it returns tool_calls; default to "".
  content: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  tool_calls: Schema.optionalWith(Schema.Array(ToolCallSchema), {
    default: () => [],
  }),
});

const ChatCompletionSchema = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: MessageSchema })),
});

const decodeChatCompletion = Schema.decodeUnknownEither(ChatCompletionSchema);

/** Build the `/chat/completions` URL, tolerating a trailing slash on baseUrl. */
export const chatCompletionsUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

/** Build the request body — exported so tests can assert the exact shape. */
export const buildChatBody = (
  req: ChatRequest,
): Record<string, unknown> => ({
  model: req.model,
  messages: [
    { role: "system", content: req.systemPrompt },
    { role: "user", content: req.userMessage },
  ],
  max_tokens: req.maxTokens,
  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  ...(req.tools !== undefined && req.tools.length > 0
    ? { tools: req.tools, tool_choice: "required" }
    : {}),
});

const fail = (
  req: ChatRequest,
  reason: ModelCallFailed["reason"],
  message: string,
): ModelCallFailed =>
  new ModelCallFailed({
    backend: req.backend,
    model: req.model,
    reason,
    message,
  });

const reasonForStatus = (status: number): ModelCallFailed["reason"] =>
  status === 401 || status === 403
    ? "auth-failed"
    : status === 429
      ? "rate-limited"
      : "bad-response";

/**
 * POST `${baseUrl}/chat/completions` and return the consumed slice. Non-2xx,
 * network failure, malformed JSON, or zero choices → `ModelCallFailed` (so the
 * run posts the failure PR comment). In tools mode the caller decides what an
 * empty `toolCalls` means (it triggers the json auto-fallback).
 */
export const chatCompletion = (
  req: ChatRequest,
): Effect.Effect<ChatResult, ModelCallFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const body = yield* HttpBody.json(buildChatBody(req)).pipe(
      Effect.mapError((e) =>
        fail(req, "unknown", `failed to encode request body: ${String(e)}`),
      ),
    );

    const request = HttpClientRequest.post(chatCompletionsUrl(req.baseUrl)).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${req.apiKey}`,
        "Content-Type": "application/json",
      }),
      HttpClientRequest.setBody(body),
    );

    const response = yield* client.execute(request).pipe(
      Effect.mapError((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        const reason: ModelCallFailed["reason"] = /timeout/i.test(msg)
          ? "timeout"
          : "unknown";
        return fail(req, reason, `request failed: ${msg}`);
      }),
    );

    if (response.status < 200 || response.status >= 300) {
      const errText = yield* response.text.pipe(
        Effect.orElseSucceed(() => ""),
      );
      return yield* Effect.fail(
        fail(
          req,
          reasonForStatus(response.status),
          `HTTP ${response.status} from /chat/completions: ${errText.slice(0, 500)}`,
        ),
      );
    }

    const json = yield* response.json.pipe(
      Effect.mapError(() =>
        fail(req, "bad-response", "response body was not valid JSON"),
      ),
    );

    const decoded = decodeChatCompletion(json);
    if (decoded._tag === "Left") {
      return yield* Effect.fail(
        fail(
          req,
          "bad-response",
          "response did not match the chat/completions shape",
        ),
      );
    }

    const choice = decoded.right.choices[0];
    if (choice === undefined) {
      return yield* Effect.fail(
        fail(req, "bad-response", "response had no choices"),
      );
    }

    const message = choice.message;
    return {
      content: message.content ?? "",
      toolCalls: message.tool_calls.map((t) => ({
        name: t.function.name,
        arguments: t.function.arguments,
      })),
    } satisfies ChatResult;
  });
