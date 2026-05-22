// @flare-dispatch/demo-agent — model adapter, built on @effect/ai.
//
// The whole agent is provider-agnostic by construction: every model call goes
// through the abstract `LanguageModel` Tag from `@effect/ai`; the concrete
// provider (OpenAI / Workers AI / a BYOK AI Gateway / Bedrock-via-compat /
// Ollama / any OpenAI-compatible endpoint) is supplied as a Layer at the run
// boundary (`makeLanguageModelLayer` below). Operators swap providers by
// pointing `MODEL_BASE_URL` at the right endpoint and putting the matching
// provider model id in the `product-demo.model.*` CONFIG_KV keys. No code
// edit.
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

import { LanguageModel, Tool, Toolkit } from "@effect/ai";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { FetchHttpClient } from "@effect/platform";
import { Config, Effect, Layer, Match, Option, Schema } from "effect";
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

/**
 * Layer providing `LanguageModel` backed by an OpenAI-compatible endpoint.
 * `MODEL_BASE_URL` defaults to OpenAI's public API; in production an
 * operator points it at Cloudflare AI Gateway's `/v1/<account>/<gateway>/compat`
 * or any other compatible endpoint (Workers AI, Anthropic-via-compat, Ollama,
 * vLLM, …). The wire protocol is `/v1/chat/completions`; the provider behind
 * it is the operator's choice.
 */
export const makeLanguageModelLayer = (
  modelName: string,
): Layer.Layer<LanguageModel.LanguageModel, never, never> => {
  const clientLayer = OpenAiClient.layerConfig({
    apiKey: Config.redacted("MODEL_API_KEY").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    ),
    apiUrl: Config.string("MODEL_BASE_URL").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    ),
  }).pipe(Layer.provide(FetchHttpClient.layer));

  const languageModelLayer = OpenAiLanguageModel.layer({ model: modelName });

  // `layerConfig` carries a `ConfigError` channel — orDie collapses it; a
  // missing MODEL_API_KEY / MODEL_BASE_URL would surface as a runtime defect,
  // which is the right shape for a misconfigured deploy (fail fast, loudly).
  return Layer.provide(languageModelLayer, clientLayer).pipe(Layer.orDie);
};

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
