// @flare-dispatch/runtime-cf — ModelGatewayLive: the live `modelGateway` capability.
//
// Backs the `ModelGateway` Context.Tag with the Cloudflare Workers AI binding
// (`env.AI`), optionally routed through an AI Gateway. The binding IS the auth —
// Workers AI is account-billed, so no API key travels with the request. This is
// the whole point of routing through the binding rather than POSTing to the
// gateway's OpenAI-compatible `/chat/completions` endpoint: it eliminates the
// per-backend secret.
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
// --- Locally-typed binding surface -------------------------------------------
//
// Like `email-cf.ts` types only the slice of `SendEmail` it uses, this types
// only the `run` overload it calls — decoupled from the exact
// `@cloudflare/workers-types` `Ai` generic, and trivially fakeable in unit
// tests with a plain object.
//
// Spec: specs/03-dsl.md § Capabilities.

import { Effect, Layer } from "effect";
import {
  ModelGateway,
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

/**
 * The minimal surface of Cloudflare's Workers AI binding (`env.AI`) this Layer
 * uses — the text-generation `run` overload. Typed locally (rather than the
 * global `Ai` generic) so the Layer stays decoupled from the workers-types
 * version and is fakeable in unit tests with a plain object.
 */
export type AiBinding = {
  readonly run: (
    model: string,
    inputs: AiTextInputs,
    options?: { gateway: { id: string } },
  ) => Promise<AiTextOutput>;
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

/**
 * Build the `ModelGateway` Layer backed by the Workers AI binding.
 *
 * @param ai         `env.AI` — the Workers AI binding.
 * @param gatewayId  optional AI Gateway id to route through (`AI_GATEWAY_ID`).
 *                   `undefined` → call Workers AI directly (no gateway).
 */
export const makeModelGatewayLive = (
  ai: AiBinding,
  gatewayId: string | undefined,
): Layer.Layer<ModelGateway> => {
  const service: ModelGatewayService = {
    complete: (req) =>
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
      }),
  };

  return Layer.succeed(ModelGateway, service);
};
