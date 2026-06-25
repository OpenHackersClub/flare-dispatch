// @flare-dispatch/runtime-cf — ModelGatewayLive: the live `modelGateway` capability.
//
// Backs the `ModelGateway` Context.Tag with the Cloudflare Workers AI binding
// (`env.AI`), optionally routed through an AI Gateway. The binding IS the auth —
// Workers AI is account-billed, so no API key travels with the request. This is
// the whole point of routing through the binding rather than POSTing to the
// gateway's OpenAI-compatible `/chat/completions` endpoint: it eliminates the
// per-backend secret.
//
// --- Four routes, selected by the model id prefix ---------------------------
//
// `@cf/...` (Workers AI catalog)          → `ai.run(model, inputs, {gateway})`
// `anthropic/<model>` (provider via BYOK)  → `ai.gateway(id).run({provider,...})`
// `deepseek/<model>` (provider via BYOK)   → `ai.gateway(id).run({provider,...})`
// `bedrock/<model>` (AWS Bedrock via SigV4) → `invokeBedrockViaAiGateway(...)`
//
// The Anthropic AND DeepSeek routes are both the AI Gateway UNIVERSAL endpoint,
// still through the binding (`env.AI.gateway(id)`), so the no-secret property is
// preserved: the gateway holds the provider key (BYOK / stored keys) and
// injects it upstream; the Worker authenticates by being in-account. DeepSeek
// is the home of the strongest open reasoning models (DeepSeek-R1 /
// `deepseek-reasoner`); routing it here lets the `reasonix` backend target the
// real hosted reasoner — `deepseek/deepseek-reasoner` — instead of the weaker
// Workers AI catalog distill (`@cf/deepseek-ai/...`), same no-secret property.
//
// The Bedrock route is different: AWS InvokeModel requires a SigV4-signed
// request, and Workers AI doesn't currently expose a `bedrock` provider on the
// universal endpoint with BYOC trust (assume-role). So the route bypasses the
// binding and POSTs the SigV4-signed request to the AI Gateway's Bedrock
// forwarder URL — the gateway adds caching + observability + cost dashboards
// without touching the AWS credentials (they ride in the Authorization header
// it forwards verbatim). Per-execution short-lived STS creds come in on
// `req.aws`; no long-lived AWS keys live on the runtime layer.
//
// --- The Workers AI text-generation contract ---------------------------------
//
//   ai.run(model, { messages, tools? }, gatewayId ? { gateway: { id } } : undefined)
//     → AiTextGenerationOutput = { response?: string; tool_calls?: [...] }
//
// `messages` is `[{role:"system",...},{role:"user",...}]`. `tools`, when sent,
// is the Workers-AI tool shape `{ type:"function", function:{ name, description,
// parameters:<jsonschema> } }`. The model's tool calls come back on
// `tool_calls`, each `{ name, arguments }` where — UNLIKE the OpenAI wire
// shape — `arguments` is already a parsed OBJECT, not a JSON string. The
// caller (the review engine) tolerates both.
//
// --- The Anthropic Messages contract (universal route) ------------------------
//
//   ai.gateway(id).run({ provider: "anthropic", endpoint: "v1/messages",
//                        headers, query: <Messages API body> }) → Response
//
// The body carries `system` + one user message; `tools` map to Anthropic's
// `{ name, description, input_schema }` shape with `tool_choice: {type:"any"}`
// (forced tool use — mirrors the engine's "tools" mode expectation). The
// response's `content` blocks map back: `text` blocks concatenate into `text`,
// `tool_use` blocks become `toolCalls` (arguments already a parsed object).
//
// --- The DeepSeek contract (universal route, OpenAI-compatible) ---------------
//
//   ai.gateway(id).run({ provider: "deepseek", endpoint: "chat/completions",
//                        headers, query: <OpenAI ChatCompletions body> }) → Response
//
// DeepSeek speaks the OpenAI Chat Completions wire shape: `messages` carries the
// system + user turns; the answer comes back at `choices[0].message.content`
// (a STRING), and tool calls — if any — at `choices[0].message.tool_calls`,
// each `{ function: { name, arguments } }` where `arguments` is a JSON STRING
// (OpenAI shape; the review engine's `parseToolArguments` already tolerates a
// string vs an object). `deepseek-reasoner` emits its chain-of-thought on a
// separate `reasoning_content` field — NOT inside `content` — so the engine's
// json-mode `text` is already the clean answer; the `<think>` stripper is a
// harmless backstop. The `reasonix` backend defaults to json mode (no tools),
// matching the reasoner's "no function calling" reality; the tool-call mapping
// is there so a future `deepseek-chat` tools-mode call works.
//
// --- Locally-typed binding surface -------------------------------------------
//
// Like `email-cf.ts` types only the slice of `SendEmail` it uses, this types
// only the `run`/`gateway` overloads it calls — decoupled from the exact
// `@cloudflare/workers-types` `Ai` generic, and trivially fakeable in unit
// tests with a plain object.
//
// Spec: specs/03-dsl.md § Capabilities.

import { Effect, Layer } from "effect";
import {
  ModelGateway,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  ModelGatewayError,
  type ModelGatewayService,
  type ModelToolCall,
} from "@flare-dispatch/core";
import { invokeBedrockViaAiGateway } from "./bedrock-invoke";

/** A `messages` entry sent to Workers AI. */
type AiMessage = { readonly role: string; readonly content: string };

/** A `tools` entry sent to Workers AI (the OpenAI-style function-tool shape). */
type AiTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the tool's arguments. */
    readonly parameters: unknown;
  };
};

/** The text-generation inputs this Layer sends. */
type AiTextInputs = {
  readonly messages: ReadonlyArray<AiMessage>;
  readonly tools?: ReadonlyArray<AiTool>;
  readonly max_tokens?: number;
  readonly temperature?: number;
  /**
   * Constrained-decoding hint (Workers AI guided generation). Models that
   * support it emit schema-valid JSON; others ignore the field.
   */
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: unknown;
  };
};

/**
 * Build the OpenAI-style `response_format` for a JSON Schema, or `{}` when no
 * schema is set — spread into a request so the no-schema path is unchanged.
 */
const jsonResponseFormat = (
  jsonSchema: unknown,
): { response_format?: { type: "json_schema"; json_schema: unknown } } =>
  jsonSchema !== undefined
    ? { response_format: { type: "json_schema", json_schema: jsonSchema } }
    : {};

/** The slice of `AiTextGenerationOutput` this Layer reads. */
type AiTextOutput = {
  readonly response?: string;
  readonly tool_calls?: ReadonlyArray<{ name: string; arguments: unknown }>;
};

/** A universal-endpoint request sent through `env.AI.gateway(id).run(...)`. */
export type AiGatewayUniversalRequest = {
  readonly provider: string;
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  readonly query: unknown;
};

/** The slice of the `AiGateway` binding object this Layer uses. */
export type AiGatewayBinding = {
  readonly run: (data: AiGatewayUniversalRequest) => Promise<Response>;
};

/**
 * The minimal surface of Cloudflare's Workers AI binding (`env.AI`) this Layer
 * uses — the text-generation `run` overload plus the `gateway` accessor for the
 * universal-endpoint route. Typed locally (rather than the global `Ai` generic)
 * so the Layer stays decoupled from the workers-types version and is fakeable
 * in unit tests with a plain object.
 */
export type AiBinding = {
  readonly run: (
    model: string,
    inputs: AiTextInputs,
    options?: { gateway: { id: string } },
  ) => Promise<AiTextOutput>;
  /** `env.AI.gateway(id)` — universal-endpoint access for BYOK providers. */
  readonly gateway?: (gatewayId: string) => AiGatewayBinding;
};

/**
 * The `cf-aig-authorization` header for an [Authenticated
 * Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/),
 * or `{}` when no token is configured. Spread into a universal-endpoint
 * request's `headers` (the gateway forwards them verbatim) so the BYOK routes
 * authenticate against a gateway with authentication turned on. An empty object
 * keeps the unauthenticated-gateway path byte-identical.
 */
const aigAuthHeader = (
  gatewayAuthToken: string | undefined,
): Record<string, string> =>
  gatewayAuthToken !== undefined
    ? { "cf-aig-authorization": `Bearer ${gatewayAuthToken}` }
    : {};

/** Map a thrown binding error to a `ModelGatewayError.reason`. */
const reasonFor = (
  message: string,
): ModelGatewayError["reason"] => {
  const m = message.toLowerCase();
  if (m.includes("429") || m.includes("rate")) return "rate-limited";
  if (m.includes("401") || m.includes("403") || m.includes("unauthor"))
    return "auth-failed";
  if (m.includes("timeout")) return "timeout";
  return "unknown";
};

/** Map a universal-endpoint HTTP status to a `ModelGatewayError.reason`. */
const reasonForStatus = (status: number): ModelGatewayError["reason"] => {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 408 || status === 504) return "timeout";
  return "bad-response";
};

// ---------------------------------------------------------------------------
// The Anthropic universal route.

/** Model ids carrying this prefix route via the universal endpoint. */
const ANTHROPIC_PREFIX = "anthropic/";

/**
 * Anthropic's Messages API requires `max_tokens`; used when the caller didn't
 * set one. Matches the review engine's own per-call budget.
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 2048;

/** The Messages API version pin — required on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

/** The slice of an Anthropic Messages response `content` block this Layer reads. */
type AnthropicContentBlock = {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
};

/** Build the Anthropic Messages API request body from a completion request. */
const anthropicBody = (
  req: ModelCompletionRequest,
  model: string,
): unknown => ({
  model,
  max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
  system: req.system,
  messages: [{ role: "user", content: req.user }],
  ...(req.tools !== undefined && req.tools.length > 0
    ? {
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        // Forced tool use — mirrors the engine's "tools" mode expectation the
        // same way Workers AI models are asked to call the supplied tool.
        tool_choice: { type: "any" },
      }
    : {}),
  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
});

/** Map Anthropic `content` blocks onto the capability's `{toolCalls, text}`. */
const fromAnthropicContent = (
  content: ReadonlyArray<AnthropicContentBlock>,
): ModelCompletionResult => ({
  toolCalls: content
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({ name: b.name as string, arguments: b.input })),
  text: content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(""),
});

/** The Workers AI catalog route — `ai.run(model, inputs, {gateway})`. */
const completeWorkersAi = (
  ai: AiBinding,
  gatewayId: string | undefined,
  req: ModelCompletionRequest,
): Effect.Effect<ModelCompletionResult, ModelGatewayError> =>
  Effect.gen(function* () {
    const sendingTools = req.tools !== undefined && req.tools.length > 0;
    const inputs: AiTextInputs = {
      // Workers AI chat templates (observed on llama-3.3) DROP the system
      // message when `tools` are present — identical prompt token counts with
      // and without it. Fold the system instruction into the user message on
      // the tools path so it actually reaches the model; keep the separate
      // system role on the plain-text path, where templates honour it.
      messages: sendingTools
        ? [{ role: "user", content: `${req.system}\n\n${req.user}` }]
        : [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
      ...(sendingTools
        ? {
            tools: (req.tools ?? []).map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...jsonResponseFormat(req.jsonSchema),
    };

    const output = yield* Effect.tryPromise({
      try: () =>
        gatewayId !== undefined
          ? ai.run(req.model, inputs, { gateway: { id: gatewayId } })
          : ai.run(req.model, inputs),
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return new ModelGatewayError({
          model: req.model,
          reason: reasonFor(message),
          message: `Workers AI run failed: ${message}`,
        });
      },
    });

    const toolCalls: ReadonlyArray<ModelToolCall> = (
      output.tool_calls ?? []
    ).map((c) => ({ name: c.name, arguments: c.arguments }));

    // Some Workers AI models occasionally return `response` as a *parsed
    // object* instead of a string (e.g. JSON-shaped completions, or some
    // versions of llama-3.x with structured-output prompts). The downstream
    // engine's `parseStructured` rejects non-string `text` with
    // `StructuredOutputInvalid: got object` — but an honest non-string at
    // this boundary should be JSON-stringified so the engine has something
    // to parse, instead of dying with a generic "got object". This mirrors
    // the same defensive coercion `parseToolArguments` already does for
    // tool-call args returned as objects vs JSON strings.
    const text =
      typeof output.response === "string"
        ? output.response
        : output.response === undefined || output.response === null
          ? ""
          : JSON.stringify(output.response);

    return {
      toolCalls,
      text,
    } satisfies ModelCompletionResult;
  });

/**
 * The Anthropic universal route — `ai.gateway(id).run({provider:"anthropic"})`.
 * The gateway's stored provider key (BYOK) is the upstream auth; the binding is
 * the gateway auth. Requires both the `gateway` accessor on the binding and a
 * configured gateway id — each absence fails with a `ModelGatewayError` naming
 * what to set, so the run's error boundary can tell the operator.
 */
const completeAnthropic = (
  ai: AiBinding,
  gatewayId: string | undefined,
  gatewayAuthToken: string | undefined,
  req: ModelCompletionRequest,
): Effect.Effect<ModelCompletionResult, ModelGatewayError> =>
  Effect.gen(function* () {
    if (ai.gateway === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "AI binding has no gateway() accessor — anthropic/* models need a Workers AI binding with AI Gateway support",
        }),
      );
    }
    if (gatewayId === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "anthropic/* models route via the AI Gateway universal endpoint — set AI_GATEWAY_ID (a gateway with a stored Anthropic key)",
        }),
      );
    }
    const gateway = ai.gateway(gatewayId);
    const model = req.model.slice(ANTHROPIC_PREFIX.length);

    const response = yield* Effect.tryPromise({
      try: () =>
        gateway.run({
          provider: "anthropic",
          endpoint: "v1/messages",
          headers: {
            "content-type": "application/json",
            // The gateway forwards headers verbatim — Anthropic rejects a
            // Messages call without its API version pin.
            "anthropic-version": ANTHROPIC_VERSION,
            ...aigAuthHeader(gatewayAuthToken),
          },
          query: anthropicBody(req, model),
        }),
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return new ModelGatewayError({
          model: req.model,
          reason: reasonFor(message),
          message: `AI Gateway anthropic run failed: ${message}`,
        });
      },
    });

    if (!response.ok) {
      const bodyText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new ModelGatewayError({
            model: req.model,
            reason: reasonForStatus(response.status),
            message: `anthropic returned ${response.status} (unreadable body)`,
          }),
      });
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: reasonForStatus(response.status),
          message: `anthropic returned ${response.status}: ${bodyText.slice(0, 300)}`,
        }),
      );
    }

    const parsed = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ content?: ReadonlyArray<AnthropicContentBlock> }>,
      catch: () =>
        new ModelGatewayError({
          model: req.model,
          reason: "bad-response",
          message: "anthropic response body was not valid JSON",
        }),
    });

    return fromAnthropicContent(parsed.content ?? []);
  });

// ---------------------------------------------------------------------------
// The DeepSeek universal route (OpenAI-compatible Chat Completions).

/** Model ids carrying this prefix route via the universal endpoint to DeepSeek. */
const DEEPSEEK_PREFIX = "deepseek/";

/**
 * DeepSeek (OpenAI-compatible) accepts `max_tokens`; supplied when the caller
 * didn't set one. Matches the review engine's own per-call budget.
 */
const DEEPSEEK_DEFAULT_MAX_TOKENS = 2048;

/** The slice of an OpenAI Chat Completions `tool_calls` entry this Layer reads. */
type OpenAiToolCall = {
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
};

/** The slice of an OpenAI Chat Completions response this Layer reads. */
type OpenAiChatResponse = {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<OpenAiToolCall>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
};

/** Build the OpenAI Chat Completions request body for DeepSeek. */
const deepseekBody = (
  req: ModelCompletionRequest,
  model: string,
): unknown => ({
  model,
  max_tokens: req.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
  messages: [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ],
  ...(req.tools !== undefined && req.tools.length > 0
    ? {
        tools: req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        // Forced tool use — the OpenAI-shape equivalent of Anthropic's
        // `tool_choice: {type:"any"}`. (deepseek-reasoner ignores tools; the
        // `reasonix` backend uses json mode so this branch is dormant there.)
        tool_choice: "required",
      }
    : {}),
  // Constrained decoding (json mode): OpenAI-compatible `json_object` is the
  // widely-supported form — the schema itself rides in the prompt contract. Only
  // set when no tools are sent (the two are mutually exclusive on this route).
  ...(req.jsonSchema !== undefined &&
  !(req.tools !== undefined && req.tools.length > 0)
    ? { response_format: { type: "json_object" } }
    : {}),
  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
});

/** Map an OpenAI Chat Completions response onto the capability's `{toolCalls, text}`. */
const fromOpenAiChat = (
  parsed: OpenAiChatResponse,
): ModelCompletionResult => {
  const message = parsed.choices?.[0]?.message;
  const toolCalls: ReadonlyArray<ModelToolCall> = (message?.tool_calls ?? [])
    .filter((c) => typeof c.function?.name === "string")
    // `arguments` is a JSON STRING (OpenAI shape); pass it through verbatim —
    // the engine's `parseToolArguments` JSON-parses a string before decode.
    .map((c) => ({
      name: c.function!.name as string,
      arguments: c.function?.arguments,
    }));
  return {
    toolCalls,
    text: typeof message?.content === "string" ? message.content : "",
    ...(typeof parsed.usage?.prompt_tokens === "number"
      ? { inputTokens: parsed.usage.prompt_tokens }
      : {}),
    ...(typeof parsed.usage?.completion_tokens === "number"
      ? { outputTokens: parsed.usage.completion_tokens }
      : {}),
  } satisfies ModelCompletionResult;
};

/**
 * The DeepSeek universal route — `ai.gateway(id).run({provider:"deepseek"})`.
 * Mirrors {@link completeAnthropic}: the gateway's stored DeepSeek key (BYOK) is
 * the upstream auth; the binding is the gateway auth (no per-backend secret on
 * the Worker). Requires both the `gateway` accessor on the binding and a
 * configured gateway id — each absence fails with a `ModelGatewayError` naming
 * what to set, so the run's error boundary can tell the operator.
 */
const completeDeepSeek = (
  ai: AiBinding,
  gatewayId: string | undefined,
  gatewayAuthToken: string | undefined,
  req: ModelCompletionRequest,
): Effect.Effect<ModelCompletionResult, ModelGatewayError> =>
  Effect.gen(function* () {
    if (ai.gateway === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "AI binding has no gateway() accessor — deepseek/* models need a Workers AI binding with AI Gateway support",
        }),
      );
    }
    if (gatewayId === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "deepseek/* models route via the AI Gateway universal endpoint — set AI_GATEWAY_ID (a gateway with a stored DeepSeek key)",
        }),
      );
    }
    const gateway = ai.gateway(gatewayId);
    const model = req.model.slice(DEEPSEEK_PREFIX.length);

    const response = yield* Effect.tryPromise({
      try: () =>
        gateway.run({
          provider: "deepseek",
          endpoint: "chat/completions",
          headers: {
            "content-type": "application/json",
            ...aigAuthHeader(gatewayAuthToken),
          },
          query: deepseekBody(req, model),
        }),
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return new ModelGatewayError({
          model: req.model,
          reason: reasonFor(message),
          message: `AI Gateway deepseek run failed: ${message}`,
        });
      },
    });

    if (!response.ok) {
      const bodyText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new ModelGatewayError({
            model: req.model,
            reason: reasonForStatus(response.status),
            message: `deepseek returned ${response.status} (unreadable body)`,
          }),
      });
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: reasonForStatus(response.status),
          message: `deepseek returned ${response.status}: ${bodyText.slice(0, 300)}`,
        }),
      );
    }

    const parsed = yield* Effect.tryPromise({
      try: () => response.json() as Promise<OpenAiChatResponse>,
      catch: () =>
        new ModelGatewayError({
          model: req.model,
          reason: "bad-response",
          message: "deepseek response body was not valid JSON",
        }),
    });

    return fromOpenAiChat(parsed);
  });

// ---------------------------------------------------------------------------
// The Bedrock-via-AI-Gateway route.

/** Model ids carrying this prefix route via SigV4 + AI Gateway Bedrock URL. */
const BEDROCK_PREFIX = "bedrock/";

const BEDROCK_DEFAULT_MAX_TOKENS = 2048;

/** Anthropic-on-Bedrock body version pin — required on every InvokeModel call. */
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * Build the Anthropic-on-Bedrock InvokeModel body. Bedrock's wire shape for
 * Anthropic models is the Anthropic Messages API body MINUS the `model` field
 * (the model id is in the URL) PLUS an `anthropic_version` field.
 */
const bedrockAnthropicBody = (req: ModelCompletionRequest): unknown => ({
  anthropic_version: BEDROCK_ANTHROPIC_VERSION,
  max_tokens: req.maxTokens ?? BEDROCK_DEFAULT_MAX_TOKENS,
  system: req.system,
  messages: [{ role: "user", content: req.user }],
  ...(req.tools !== undefined && req.tools.length > 0
    ? {
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        // Forced tool use — same as the Anthropic universal route.
        tool_choice: { type: "any" },
      }
    : {}),
  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
});

/**
 * The Bedrock route. Pinned to AI Gateway: requires both a `cloudflareAccountId`
 * and a `gatewayId` configured on the runtime layer. AWS credentials come in on
 * `req.aws` — short-lived STS creds the run minted via `awsAssumeRole`. Each
 * absence (missing aws creds, missing account id, missing gateway id) fails
 * with a `ModelGatewayError` naming what to set, so the run's error boundary
 * can tell the operator.
 */
const completeBedrock = (
  cloudflareAccountId: string | undefined,
  gatewayId: string | undefined,
  gatewayAuthToken: string | undefined,
  req: ModelCompletionRequest,
): Effect.Effect<ModelCompletionResult, ModelGatewayError> =>
  Effect.gen(function* () {
    if (req.aws === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "auth-failed",
          message:
            "bedrock/* models need short-lived AWS credentials on req.aws — mint them with awsAssumeRole(roleArn) inside the run",
        }),
      );
    }
    if (cloudflareAccountId === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "bedrock/* models route via the AI Gateway Bedrock forwarder — set CLOUDFLARE_ACCOUNT_ID on the dispatcher",
        }),
      );
    }
    if (gatewayId === undefined) {
      return yield* Effect.fail(
        new ModelGatewayError({
          model: req.model,
          reason: "unknown",
          message:
            "bedrock/* models route via the AI Gateway Bedrock forwarder — set AI_GATEWAY_ID on the dispatcher",
        }),
      );
    }

    const modelId = req.model.slice(BEDROCK_PREFIX.length);
    const result = yield* Effect.tryPromise({
      try: () =>
        invokeBedrockViaAiGateway({
          creds: {
            accessKeyId: req.aws!.accessKeyId,
            secretAccessKey: req.aws!.secretAccessKey,
            sessionToken: req.aws!.sessionToken,
          },
          region: req.aws!.region,
          modelId,
          body: bedrockAnthropicBody(req),
          cloudflareAccountId,
          gatewayId,
          ...(gatewayAuthToken !== undefined ? { gatewayAuthToken } : {}),
        }),
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return new ModelGatewayError({
          model: req.model,
          reason: reasonFor(message),
          message: `Bedrock InvokeModel via AI Gateway failed: ${message}`,
        });
      },
    });

    // Anthropic-on-Bedrock returns `{content:[{type,text|name+input}]}`. The
    // shared helper concatenated the text blocks already; we don't get the raw
    // content array back, so tool-call extraction would need a richer return
    // type. V0: text-only (the run that needs this route — pr-review's
    // `bedrock` backend — uses text mode). Tools mode on
    // Bedrock is a separate scope.
    return {
      toolCalls: [],
      text: result.response,
      ...(result.inputTokens !== undefined
        ? { inputTokens: result.inputTokens }
        : {}),
      ...(result.outputTokens !== undefined
        ? { outputTokens: result.outputTokens }
        : {}),
    } satisfies ModelCompletionResult;
  });

/**
 * Build the `ModelGateway` Layer. The model id prefix selects the route:
 *
 *   `bedrock/<model>`   → AI Gateway Bedrock forwarder (SigV4, BYOC creds)
 *   `anthropic/<model>` → AI Gateway universal endpoint (BYOK Anthropic key)
 *   `deepseek/<model>`  → AI Gateway universal endpoint (BYOK DeepSeek key)
 *   anything else       → Workers AI catalog (`@cf/...`)
 *
 * @param ai                   `env.AI` — the Workers AI binding.
 * @param gatewayId            optional AI Gateway id (`AI_GATEWAY_ID`). Required
 *                             for the `anthropic/*`, `deepseek/*` and
 *                             `bedrock/*` routes.
 * @param cloudflareAccountId  Cloudflare account id (`CLOUDFLARE_ACCOUNT_ID`).
 *                             Required for the `bedrock/*` route — it's the
 *                             first segment of the AI Gateway Bedrock URL.
 * @param gatewayAuthToken     optional `cf-aig-authorization` token for
 *                             Authenticated Gateway. Forwarded on every route
 *                             that hits the gateway — `anthropic/*`,
 *                             `deepseek/*`, and `bedrock/*`. The `@cf/*`
 *                             Workers AI route goes through the binding (not the
 *                             universal endpoint), which has no header seam, so
 *                             an authenticated gateway must allow first-party
 *                             Workers AI binding traffic.
 */
export const makeModelGatewayLive = (
  ai: AiBinding,
  gatewayId: string | undefined,
  cloudflareAccountId?: string,
  gatewayAuthToken?: string,
): Layer.Layer<ModelGateway> => {
  const service: ModelGatewayService = {
    complete: (req) =>
      req.model.startsWith(BEDROCK_PREFIX)
        ? completeBedrock(cloudflareAccountId, gatewayId, gatewayAuthToken, req)
        : req.model.startsWith(ANTHROPIC_PREFIX)
          ? completeAnthropic(ai, gatewayId, gatewayAuthToken, req)
          : req.model.startsWith(DEEPSEEK_PREFIX)
            ? completeDeepSeek(ai, gatewayId, gatewayAuthToken, req)
            : completeWorkersAi(ai, gatewayId, req),
  };

  return Layer.succeed(ModelGateway, service);
};
