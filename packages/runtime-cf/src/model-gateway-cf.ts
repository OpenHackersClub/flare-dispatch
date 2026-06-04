// @flare-dispatch/runtime-cf — ModelGatewayLive: the live `modelGateway` capability.
//
// Backs the `ModelGateway` Context.Tag with the Cloudflare Workers AI binding
// (`env.AI`), optionally routed through an AI Gateway. The binding IS the auth —
// Workers AI is account-billed, so no API key travels with the request. This is
// the whole point of routing through the binding rather than POSTing to the
// gateway's OpenAI-compatible `/chat/completions` endpoint: it eliminates the
// per-backend secret.
//
// --- Two routes, selected by the model id ------------------------------------
//
// `@cf/...` (Workers AI catalog)         → `ai.run(model, inputs, {gateway})`
// `anthropic/<model>` (provider via BYOK) → `ai.gateway(id).run({provider,...})`
//
// The second route is the AI Gateway UNIVERSAL endpoint, still through the
// binding (`env.AI.gateway(id)`), so the no-secret property is preserved: the
// gateway holds the provider key (BYOK / stored keys) and injects it upstream;
// the Worker authenticates by being in-account. This is what lets a run review
// with a frontier model (e.g. `anthropic/claude-sonnet-4-6`) instead of being
// limited to the Workers AI catalog.
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
};

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
    const inputs: AiTextInputs = {
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...(req.tools !== undefined && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
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

    return {
      toolCalls,
      text: output.response ?? "",
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
          headers: { "content-type": "application/json" },
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

/**
 * Build the `ModelGateway` Layer backed by the Workers AI binding. The model id
 * selects the route: `anthropic/<model>` goes through the AI Gateway universal
 * endpoint (BYOK provider key stored in the gateway); anything else is run as a
 * Workers AI catalog model.
 *
 * @param ai         `env.AI` — the Workers AI binding.
 * @param gatewayId  optional AI Gateway id to route through (`AI_GATEWAY_ID`).
 *                   `undefined` → Workers AI runs directly (no gateway), and
 *                   `anthropic/*` models fail with an operator-facing error.
 */
export const makeModelGatewayLive = (
  ai: AiBinding,
  gatewayId: string | undefined,
): Layer.Layer<ModelGateway> => {
  const service: ModelGatewayService = {
    complete: (req) =>
      req.model.startsWith(ANTHROPIC_PREFIX)
        ? completeAnthropic(ai, gatewayId, req)
        : completeWorkersAi(ai, gatewayId, req),
  };

  return Layer.succeed(ModelGateway, service);
};
