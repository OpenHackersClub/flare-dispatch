// @flare-dispatch/demo-agent — model adapter, built on @effect/ai.
//
// The whole agent is provider-agnostic by construction: every model call goes
// through the abstract `LanguageModel` Tag from `@effect/ai`; the concrete
// provider (OpenAI / Workers AI / Anthropic-via-compat / Bedrock / …) sits
// behind a Cloudflare AI Gateway and is supplied as a Layer at the run boundary
// (`makeLanguageModelLayer` below). Operators swap providers by reconfiguring
// the gateway and putting the matching provider model id in the
// `product-demo.model.*` CONFIG_KV keys. No code edit.
//
// Two call sites:
//
//   1. `pickNextAction` — the play loop's per-step "what does the user do
//      next?" call. Instead of asking the model to emit raw JSON and
//      parse-and-validate-and-retry, we register one `Tool` per `ModelAction`
//      variant and force a tool call (`toolChoice: "required"`). The model
//      picks ONE tool; we map the tool name + arguments back into the
//      existing `ModelAction` union via `Match`. The Schema-validated tool
//      args are the action's parameters, so a malformed pick fails inside
//      `@effect/ai`'s decoder, not in our hand-rolled `tryParseJson`.
//
//   2. `summarizeStories` — free-form markdown over the stories.json +
//      optional previous summary. Plain `generateText`, no toolkit.
//
// `disableToolCallResolution: true` keeps `@effect/ai` from auto-invoking the
// stub handlers; we just inspect `response.toolCalls`. The handlers are
// `Effect.void` because the actual side effect (CDP command apply) lives in
// the play loop where it can be retried, screenshotted, and timed.

import { AiError, LanguageModel, type Response, Tool, Toolkit } from "@effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import {
  Config,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { MissingEnv, ModelCallFailed } from "./errors.js";
import {
  type ModelAction,
  type StorySummaryInput,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// One Tool per ModelAction variant.
//
// `parameters` mirrors the per-variant fields on `schemas.ModelAction`; the
// model's "function call" of the tool IS the action choice. `success` is
// `Schema.Void` because the handler is a stub — the play loop applies the
// action via CDP, not the toolkit handler.

const ClickTool = Tool.make("click", {
  description:
    "Click an element identified by an accessibility node id (preferred) or CSS selector.",
  parameters: {
    target: Schema.String.annotations({
      description:
        "Accessibility node id or CSS selector for the element to click.",
    }),
    rationale: Schema.optional(Schema.String).annotations({
      description: "One-sentence rationale for why this click moves the story forward.",
    }),
  },
});

const TypeTool = Tool.make("type", {
  description:
    "Focus an element by accessibility node id or CSS selector and type the supplied text into it.",
  parameters: {
    target: Schema.String.annotations({
      description:
        "Accessibility node id or CSS selector for the element to focus + type into.",
    }),
    text: Schema.String.annotations({
      description: "Text to type into the focused element.",
    }),
    rationale: Schema.optional(Schema.String),
  },
});

const NavTool = Tool.make("nav", {
  description: "Navigate the page to an absolute URL.",
  parameters: {
    url: Schema.String.annotations({
      description: "Absolute URL to navigate to.",
    }),
    rationale: Schema.optional(Schema.String),
  },
});

const KeyTool = Tool.make("key", {
  description:
    "Press a single key (CDP key name, e.g. Enter, Tab, Escape, ArrowDown).",
  parameters: {
    key: Schema.String.annotations({
      description: "CDP key name (Enter, Tab, Escape, ArrowDown, ...).",
    }),
    rationale: Schema.optional(Schema.String),
  },
});

const WaitTool = Tool.make("wait", {
  description:
    "Wait the supplied number of milliseconds (clamped to 0..5000 by the loop).",
  parameters: {
    ms: Schema.Number.annotations({
      description: "Milliseconds to wait (will be clamped to 0..5000).",
    }),
    rationale: Schema.optional(Schema.String),
  },
});

const ScreenshotTool = Tool.make("screenshot", {
  description:
    "Mark the current frame as the story's KEY screenshot. Use exactly once per story at the moment that best captures the outcome.",
  parameters: {
    rationale: Schema.optional(Schema.String).annotations({
      description:
        "Why this frame is the key moment for the story (one short sentence).",
    }),
  },
});

const DoneTool = Tool.make("done", {
  description:
    "Signal the story is complete (success or failure) and return the narrative.",
  parameters: {
    narrative: Schema.String.annotations({
      description: "2-4 sentence narrative for the story.",
    }),
    status: Schema.Literal("passed", "failed").annotations({
      description:
        "`passed` if the story's success condition was observable; `failed` for any unrecoverable obstacle.",
    }),
  },
});

const ActionToolkit = Toolkit.make(
  ClickTool,
  TypeTool,
  NavTool,
  KeyTool,
  WaitTool,
  ScreenshotTool,
  DoneTool,
);

// `Toolkit<Tools>` is itself an `Effect<WithHandler<Tools>, never,
// HandlersFor<Tools>>` — passing it as `toolkit:` to `generateText` introduces
// a `HandlersFor<Tools>` context requirement. `.toLayer({...})` provides
// those handlers. We pass stubs because `disableToolCallResolution: true`
// keeps the framework from actually invoking them — the play loop applies
// the action via CDP after inspecting `response.toolCalls`.
const ActionToolkitHandlersLayer = ActionToolkit.toLayer({
  click: () => Effect.void,
  type: () => Effect.void,
  nav: () => Effect.void,
  key: () => Effect.void,
  wait: () => Effect.void,
  screenshot: () => Effect.void,
  done: () => Effect.void,
});

// ---------------------------------------------------------------------------
// Provider Layer — operator-pinned via env.

// The Cloudflare AI Gateway OpenAI-compat endpoint. The host is fixed; only the
// account + gateway slug vary, so operators set those (not a hand-pasted URL).
const gatewayCompatUrl = (accountId: string, gatewayId: string): string =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;

// ── Chat Completions mapping ────────────────────────────────────────────────
// `@effect/ai`'s `ProviderOptions` (prompt + tools + tool-choice) ⇄ the OpenAI
// `/chat/completions` wire shape, and the response ⇄ `@effect/ai` response parts.
// Kept deliberately small + total: demo-agent only ever sends single-string
// prompts with the 7-tool action toolkit, but the mapping handles the general
// system/user/assistant/tool message shapes so it stays correct if that grows.

const FINISH_REASON: Record<string, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
};
const resolveFinish = (
  reason: string | null | undefined,
  hasToolCalls: boolean,
): string =>
  reason == null
    ? hasToolCalls
      ? "tool-calls"
      : "stop"
    : (FINISH_REASON[reason] ?? (hasToolCalls ? "tool-calls" : "unknown"));

// Flatten an `@effect/ai` message's content (string, or an array of parts) to
// plain text — demo-agent's prompts are text-only.
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => (p as { type?: string })?.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
  }
  return "";
};

const promptToMessages = (prompt: {
  readonly content: ReadonlyArray<{ role: string; content: unknown }>;
}): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        messages.push({ role: "system", content: contentText(message.content) });
        break;
      case "user":
        messages.push({ role: "user", content: contentText(message.content) });
        break;
      case "assistant": {
        const text = contentText(message.content);
        const parts = Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>)
          : [];
        const toolCalls = parts
          .filter((p) => p["type"] === "tool-call")
          .map((p) => ({
            id: p["id"],
            type: "function",
            function: {
              name: p["name"],
              arguments: JSON.stringify(p["params"]),
            },
          }));
        const m: Record<string, unknown> = { role: "assistant" };
        if (text.length > 0) m["content"] = text;
        if (toolCalls.length > 0) m["tool_calls"] = toolCalls;
        messages.push(m);
        break;
      }
      case "tool":
        for (const p of (message.content as Array<Record<string, unknown>>) ?? []) {
          messages.push({
            role: "tool",
            tool_call_id: p["id"],
            content: JSON.stringify(p["result"]),
          });
        }
        break;
    }
  }
  return messages;
};

const toolChoiceToChat = (toolChoice: unknown): unknown => {
  if (toolChoice === "auto" || toolChoice === "required" || toolChoice === "none") {
    return toolChoice;
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const tc = toolChoice as Record<string, unknown>;
    if ("tool" in tc) return { type: "function", function: { name: tc["tool"] } };
    if ("oneOf" in tc) return tc["mode"] === "required" ? "required" : "auto";
  }
  return undefined;
};

const buildChatRequest = (
  modelName: string,
  options: LanguageModel.ProviderOptions,
): Record<string, unknown> => {
  const request: Record<string, unknown> = {
    model: modelName,
    messages: promptToMessages(
      options.prompt as { content: ReadonlyArray<{ role: string; content: unknown }> },
    ),
  };
  const tools = options.tools
    .filter((t) => Tool.isUserDefined(t))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        // `getDescription`/`getJsonSchema` want a no-requirement Tool; the
        // toolkit's tools carry `any` in the requirement slot, so widen to
        // `never` (assignable) for the call.
        description: Tool.getDescription(t as never),
        parameters: Tool.getJsonSchema(t as never),
      },
    }));
  if (tools.length > 0) {
    request["tools"] = tools;
    const choice = toolChoiceToChat(options.toolChoice);
    if (choice !== undefined) request["tool_choice"] = choice;
  }
  return request;
};

const chatResponseToParts = (response: {
  readonly id?: string;
  readonly model?: string;
  readonly created?: number;
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string | null;
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}): Array<Response.PartEncoded> => {
  const choice = response.choices?.[0];
  const message = choice?.message ?? {};
  const parts: Array<Record<string, unknown>> = [
    {
      type: "response-metadata",
      id: response.id,
      modelId: response.model,
      timestamp: new Date((response.created ?? 0) * 1000).toISOString(),
    },
  ];
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ type: "text", text: message.content });
  }
  let hasToolCalls = false;
  for (const call of message.tool_calls ?? []) {
    if (call?.type !== "function" || call.function === undefined) continue;
    hasToolCalls = true;
    let params: unknown = {};
    try {
      params = JSON.parse(call.function.arguments ?? "{}");
    } catch {
      params = {};
    }
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.function.name,
      params,
    });
  }
  parts.push({
    type: "finish",
    reason: resolveFinish(choice?.finish_reason, hasToolCalls),
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  });
  return parts as unknown as Array<Response.PartEncoded>;
};

/**
 * Layer providing `LanguageModel` over the OpenAI wire protocol, always pointed
 * at a Cloudflare AI Gateway. The endpoint is DERIVED from the account + gateway
 * id (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`) — there
 * is no `MODEL_BASE_URL` to hand-paste. The gateway fans out to the upstream
 * provider (OpenAI, Workers AI, Anthropic-via-compat, Bedrock, …) so this code
 * stays provider-agnostic — the upstream is a gateway/CONFIG_KV concern.
 *
 * Credentials, each on its own axis:
 *   - `CLOUDFLARE_ACCOUNT_ID` — account owning the gateway (required; also used
 *                               by the recorder).
 *   - `CF_AI_GATEWAY_ID`      — the gateway slug in the compat URL (required).
 *   - `MODEL_API_KEY`         — the UPSTREAM provider key, sent as
 *                               `Authorization: Bearer`. Optional: leave unset
 *                               under BYOK (the gateway holds the upstream key).
 *   - `CF_AI_GATEWAY_TOKEN`   — the gateway's OWN auth (Cloudflare "Authenticated
 *                               Gateway"), sent as `cf-aig-authorization: Bearer`.
 *                               Optional: set only when the gateway is locked
 *                               down. NOT the same thing as `MODEL_API_KEY` —
 *                               it gates access *to* the gateway, orthogonal to
 *                               the upstream `Authorization` header.
 */
export const makeLanguageModelLayer = (
  modelName: string,
): Layer.Layer<LanguageModel.LanguageModel, never, never> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
      const gatewayId = yield* Config.string("CF_AI_GATEWAY_ID");
      const apiKey = yield* Config.redacted("MODEL_API_KEY").pipe(Config.option);
      const aigToken = yield* Config.redacted("CF_AI_GATEWAY_TOKEN").pipe(
        Config.option,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const url = `${gatewayCompatUrl(accountId, gatewayId)}/chat/completions`;

      // Auth headers, each optional: `cf-aig-authorization` for an Authenticated
      // Gateway, `authorization` for the upstream provider key (unset under BYOK).
      const headers: Record<string, string> = {};
      if (Option.isSome(aigToken)) {
        headers["cf-aig-authorization"] = `Bearer ${Redacted.value(aigToken.value)}`;
      }
      if (Option.isSome(apiKey)) {
        headers["authorization"] = `Bearer ${Redacted.value(apiKey.value)}`;
      }

      // Custom `LanguageModel` over the OpenAI **Chat Completions** API, driven
      // with a RAW request. `@effect/ai-openai`'s built-in `OpenAiLanguageModel`
      // is unusable against a Cloudflare AI Gateway for two reasons:
      //   1. it speaks the OpenAI *Responses* API (`POST …/responses`), which the
      //      gateway `/compat` endpoint rejects ("responses is not supported"); and
      //   2. even on `/chat/completions`, its typed client strict-decodes the
      //      response against OpenAI's exact schema, which the gateway's
      //      Anthropic-via-compat reply does not satisfy (e.g. it omits
      //      `message.refusal`).
      // So we POST the request ourselves and parse the JSON loosely, mapping it
      // into `@effect/ai` response parts. demo-agent only calls `generateText`.
      return yield* LanguageModel.make({
        generateText: (options) =>
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.post(url).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJson(buildChatRequest(modelName, options)),
            );
            const response = yield* httpClient.execute(request);
            const json = yield* response.json;
            if (response.status >= 400) {
              return yield* Effect.fail(
                new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`),
              );
            }
            return chatResponseToParts(
              json as Parameters<typeof chatResponseToParts>[0],
            );
          }).pipe(
            // A hung gateway/model request must NOT hang the whole `play` — the
            // agent loop would never reach its `--max-sec` budget check, so the
            // detached process never writes its sentinel and the run's per-story
            // step spins to the CF Workflows ~10-min cap. Bound each call; a
            // timeout surfaces as a normal model error the play loop recovers
            // from (retry / move on / wrap up).
            Effect.timeoutFail({
              duration: "120 seconds",
              onTimeout: () =>
                new Error("chat/completions request timed out after 120s"),
            }),
            Effect.mapError(
              (cause) =>
                new AiError.UnknownError({
                  module: "DemoAgentChatModel",
                  method: "generateText",
                  description: `Cloudflare AI Gateway chat/completions request failed: ${String(cause)}`,
                  cause,
                }),
            ),
          ),
        streamText: () =>
          Stream.die(
            "DemoAgentChatModel: streamText is not implemented (demo-agent uses generateText only)",
          ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.orDie);

// ---------------------------------------------------------------------------
// pickNextAction
//
// Model id passes through verbatim — the operator names the upstream model
// in CONFIG_KV (`product-demo.model.play` / `.summary`) and the same string
// flows through `--model` into `OpenAiLanguageModel.layer({ model })`.
// Provider-specific names live in the operator's config, not in this code,
// so swapping providers (`gpt-4o`, `claude-opus-4-7`, `@cf/meta/llama-3.1-70b-instruct`, …)
// is a CONFIG_KV edit.

export type PickActionInput = {
  readonly prose: string;
  readonly snapshot: string;
  readonly history: readonly string[];
  readonly secsRemaining: number;
};

/** Ask the model what the user does next. Returns one typed `ModelAction`. */
export const pickNextAction = (
  input: PickActionInput,
): Effect.Effect<ModelAction, ModelCallFailed | MissingEnv, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderActionPrompt(input),
      toolkit: ActionToolkit,
      toolChoice: "required",
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(ActionToolkitHandlersLayer),
      Effect.mapError(
        (e) =>
          new ModelCallFailed({
            model: "<provider-pinned>",
            reason: classifyModelError(e),
            message: e instanceof Error ? e.message : String(e),
          }),
      ),
    );

    // The model MUST have called exactly one tool — `toolChoice: "required"`
    // forces it. A response with zero tool calls is the most common pathology
    // when a provider doesn't honour the choice; we surface it as
    // `bad-response`.
    const calls = response.toolCalls;
    if (calls.length === 0) {
      return yield* Effect.fail(
        new ModelCallFailed({
          model: "<provider-pinned>",
          reason: "bad-response",
          message:
            "model returned no tool call despite toolChoice=required; check provider tool support",
        }),
      );
    }
    const call = calls[0]!;
    return toolCallToAction(call);
  });

const toolCallToAction = (call: {
  readonly name: string;
  readonly params: unknown;
}): ModelAction => {
  const p = call.params as Record<string, unknown>;
  // The Tool.make schema decoder has already validated `p`'s shape against
  // the per-tool parameters; we just stitch the `type` discriminant back on.
  return Match.value(call.name).pipe(
    Match.when("click", () => ({
      type: "click" as const,
      target: p["target"] as string,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("type", () => ({
      type: "type" as const,
      target: p["target"] as string,
      text: p["text"] as string,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("nav", () => ({
      type: "nav" as const,
      url: p["url"] as string,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("key", () => ({
      type: "key" as const,
      key: p["key"] as string,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("wait", () => ({
      type: "wait" as const,
      ms: p["ms"] as number,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("screenshot", () => ({
      type: "screenshot" as const,
      ...(p["rationale"] !== undefined ? { rationale: p["rationale"] as string } : {}),
    })),
    Match.when("done", () => ({
      type: "done" as const,
      narrative: p["narrative"] as string,
      status: p["status"] as "passed" | "failed",
    })),
    Match.orElse(
      () =>
        ({
          type: "done" as const,
          narrative: `model called unknown tool ${call.name}`,
          status: "failed" as const,
        }) satisfies ModelAction,
    ),
  );
};

// ---------------------------------------------------------------------------
// summarizeStories

export type SummarizeInput = {
  readonly stories: readonly StorySummaryInput[];
  readonly replayUri: string;
  readonly replayJsonUri: string;
  readonly previous?: string;
};

export const summarizeStories = (
  input: SummarizeInput,
): Effect.Effect<string, ModelCallFailed | MissingEnv, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({
      prompt: renderSummaryPrompt(input),
    }).pipe(
      Effect.mapError(
        (e) =>
          new ModelCallFailed({
            model: "<provider-pinned>",
            reason: classifyModelError(e),
            message: e instanceof Error ? e.message : String(e),
          }),
      ),
    );
    return response.text.trim();
  });

// ---------------------------------------------------------------------------
// Prompts.

const ACTION_SYSTEM_PROMPT_NOTE = `You drive a web app through one user story.

You will see the story prose, the page's accessibility tree, and the history
of actions you have already applied. Pick ONE next action by calling exactly
one of the registered tools (click | type | nav | key | wait | screenshot |
done). Do NOT respond with prose — the tool call IS the action.

THE TARGET APP IS ALREADY LOADED in the browser — the accessibility snapshot you
see IS the app under test. Operate it directly with click/type/key. Do NOT
\`nav\` to a homepage or guess a URL (e.g. never invent "app.example.com") — that
navigates away from the app and breaks the demo. Use \`nav\` ONLY for an absolute
URL the story TEXT literally spells out (e.g. a store-listing link to paste).

Rules:
- Prefer accessibility-tree node references (role + name) over CSS selectors.
- Emit ONE \`screenshot\` per story, at the moment that best captures the
  outcome.
- Stop ASAP. Call \`done\` as soon as the story's success condition is
  observable in the snapshot.
- If the page is broken (500 error, locked-out account, unreachable element),
  call \`done\` with status=failed and a narrative explaining why.
- Respect the time budget; if \`secsRemaining < 30\`, wrap up.`;

const renderActionPrompt = (input: PickActionInput): string => {
  const history =
    input.history.length === 0
      ? "(no prior actions)"
      : input.history.map((h, i) => `${i + 1}. ${h}`).join("\n");
  return [
    ACTION_SYSTEM_PROMPT_NOTE,
    "",
    `Story prose:\n${input.prose}`,
    `Time budget remaining: ${input.secsRemaining}s`,
    `Prior actions:\n${history}`,
    `Page accessibility snapshot:\n${input.snapshot}`,
    "Call ONE tool to advance (or complete) the story.",
  ].join("\n\n");
};

const SUMMARY_SYSTEM_PROMPT_NOTE = `You write the holistic walkthrough summary
a human reviewer pastes into a PR description.

Write in markdown. Three sections:
1. **TL;DR** — 1-2 sentences (X of Y stories passed).
2. **Per-story narratives** — one bullet per story (bold name, agent's
   narrative verbatim, chapter offset, screenshot link).
3. **What's new since last run** — diff highlights when a previous summary
   exists; omit the section entirely otherwise.

End with: \`Replay: <replayUri>\`.`;

const renderSummaryPrompt = (input: SummarizeInput): string => {
  const previousBlock =
    input.previous === undefined || input.previous.trim() === ""
      ? "(no previous run)"
      : input.previous;
  return [
    SUMMARY_SYSTEM_PROMPT_NOTE,
    "",
    "Stories (JSON):",
    JSON.stringify(input.stories, null, 2),
    `Replay link: ${input.replayUri}`,
    `Replay JSON: ${input.replayJsonUri}`,
    "Previous summary:",
    previousBlock,
    "Write the markdown summary per the rules above.",
  ].join("\n\n");
};

// ---------------------------------------------------------------------------

const classifyModelError = (e: unknown): ModelCallFailed["reason"] => {
  const message = e instanceof Error ? e.message.toLowerCase() : String(e);
  if (
    message.includes("missing-env") ||
    message.includes("missing env") ||
    message.includes("model_base_url") ||
    message.includes("model_api_key")
  ) {
    return "missing-api-key";
  }
  if (message.includes("401") || message.includes("403") || message.includes("unauthor")) {
    return "auth-failed";
  }
  if (message.includes("429") || message.includes("rate")) return "rate-limited";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("bad") || message.includes("invalid") || message.includes("decode"))
    return "bad-response";
  return "unknown";
};
