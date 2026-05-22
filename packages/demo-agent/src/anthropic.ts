// @flare-dispatch/demo-agent — Anthropic SDK wrapper.
//
// Two model calls in the agent's surface:
//   1. `pickNextAction(prose, snapshot, history)` — the play loop's per-step
//      "what does the user do next?" call. Returns one typed `ModelAction`.
//   2. `summarizeStories(stories, previous?, replayUri)` — the holistic
//      walkthrough write-up at the end of the run.
//
// Both calls use prompt caching for the system prompt + the snapshot prefix
// (the snapshot is invalidated each step, but the system prompt + story prose
// stay cached for the duration of the story).
//
// Transport — Cloudflare AI Gateway
// ---------------------------------
// We do NOT hit api.anthropic.com directly. The Anthropic SDK is pointed at
// the operator's Cloudflare AI Gateway via `baseURL` so that:
//
//   * the upstream Anthropic key lives in the gateway's BYOK settings, not
//     in any env var on the container — the container never sees it;
//   * gateway-level caching, rate-limit shaping, retries, and provider
//     failover come for free, with the same shape the Workers AI / pr-review
//     gateway pages already aggregate;
//   * an optional `AI_GATEWAY_TOKEN` (the gateway's authenticated-gateway
//     `cf-aig-authorization` header) gates third-party use of the URL.
//
// Required env:
//   * AI_GATEWAY_URL    — the per-provider gateway URL, e.g.
//                         `https://gateway.ai.cloudflare.com/v1/<account>/<gateway-id>/anthropic`.
//                         Missing → MissingEnv at the first model call.
//   * AI_GATEWAY_TOKEN  — optional. Sent as `cf-aig-authorization: Bearer …`
//                         when set; gateways without "Authenticated Gateway"
//                         enabled don't need this.
//
// Model IDs:
//   * Default action model: `claude-opus-4-7` (the latest Opus; matches the
//     "computer-use style multi-action loop" the planner runs).
//   * Default summary model: resolved by the run from
//     `config.get("product-demo.model.summary")`; the agent honours whatever
//     name lands in `--model`, mapping `opus` / `sonnet` / `haiku` to the
//     newest model id in each family.

import Anthropic from "@anthropic-ai/sdk";
import { Effect, Schema } from "effect";
import { MissingEnv, ModelCallFailed } from "./errors.js";
import { ModelAction, type StorySummaryInput } from "./schemas.js";

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** Resolve an alias (`opus`, `sonnet`, `haiku`) or pass through a full model id. */
export const resolveModelId = (name: string): string =>
  MODEL_ALIASES[name] ?? name;

/** Per-call options the action-picker takes. */
export type PickActionInput = {
  /** Story prose verbatim from the run input. */
  readonly prose: string;
  /** Accessibility snapshot JSON of the current page. */
  readonly snapshot: string;
  /** Prior actions applied in this story (oldest first), as compact strings. */
  readonly history: readonly string[];
  /** Wall-clock budget remaining in seconds — for the model to pace itself. */
  readonly secsRemaining: number;
  /** Override the model id; default `claude-opus-4-7`. */
  readonly model?: string;
  /** Inject a client for tests. */
  readonly client?: Anthropic;
};

/**
 * Ask the model what the user does next, given the prose + the page's
 * accessibility tree. Returns a typed `ModelAction` — parses are strict
 * (Schema.decodeUnknown), so a malformed response fails with `bad-response`.
 */
export const pickNextAction = (
  input: PickActionInput,
): Effect.Effect<ModelAction, ModelCallFailed | MissingEnv> =>
  Effect.gen(function* () {
    const client = input.client ?? (yield* clientFromEnv);
    const model = resolveModelId(input.model ?? "claude-opus-4-7");

    const systemPrompt = ACTION_SYSTEM_PROMPT;
    const userPrompt = renderActionPrompt(input);

    const response = yield* Effect.tryPromise({
      try: () =>
        client.messages.create({
          model,
          max_tokens: 1024,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userPrompt }],
        }),
      catch: (e) => mapModelError(model, e),
    });

    const text = extractText(response);
    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new ModelCallFailed({
          model,
          reason: "bad-response",
          message: `expected one JSON object, got: ${text.slice(0, 300)}`,
        }),
      );
    }

    const decode = Schema.decodeUnknownEither(ModelAction);
    const result = decode(parsed);
    if (result._tag === "Left") {
      return yield* Effect.fail(
        new ModelCallFailed({
          model,
          reason: "bad-response",
          message: `ModelAction decode: ${result.left.message}`,
        }),
      );
    }
    return result.right;
  });

export type SummarizeInput = {
  readonly stories: readonly StorySummaryInput[];
  readonly replayUri: string;
  readonly replayJsonUri: string;
  readonly previous?: string;
  readonly model?: string;
  readonly client?: Anthropic;
};

/**
 * Compose the holistic markdown summary. Plain-text response — the run
 * embeds it verbatim into the check-run summary; no JSON envelope.
 */
export const summarizeStories = (
  input: SummarizeInput,
): Effect.Effect<string, ModelCallFailed | MissingEnv> =>
  Effect.gen(function* () {
    const client = input.client ?? (yield* clientFromEnv);
    const model = resolveModelId(input.model ?? "claude-opus-4-7");

    const response = yield* Effect.tryPromise({
      try: () =>
        client.messages.create({
          model,
          max_tokens: 2048,
          system: [
            {
              type: "text",
              text: SUMMARY_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            { role: "user", content: renderSummaryPrompt(input) },
          ],
        }),
      catch: (e) => mapModelError(model, e),
    });
    return extractText(response).trim();
  });

const clientFromEnv: Effect.Effect<Anthropic, MissingEnv> = Effect.gen(
  function* () {
    const gatewayUrl = process.env.AI_GATEWAY_URL;
    if (gatewayUrl === undefined || gatewayUrl === "") {
      return yield* Effect.fail(new MissingEnv({ name: "AI_GATEWAY_URL" }));
    }
    const gatewayToken = process.env.AI_GATEWAY_TOKEN;
    // The Anthropic SDK constructor requires `apiKey` to be a non-empty
    // string. The gateway holds the real upstream key (BYOK), so the value we
    // pass here is a placeholder — it never reaches Anthropic. If the
    // operator chose a pass-through gateway instead of BYOK, they can stash
    // the real key in `ANTHROPIC_API_KEY` and it will ride along.
    const apiKey =
      process.env.ANTHROPIC_API_KEY !== undefined &&
      process.env.ANTHROPIC_API_KEY !== ""
        ? process.env.ANTHROPIC_API_KEY
        : "byok-via-ai-gateway";
    return new Anthropic({
      apiKey,
      baseURL: gatewayUrl,
      ...(gatewayToken !== undefined && gatewayToken !== ""
        ? {
            defaultHeaders: {
              "cf-aig-authorization": `Bearer ${gatewayToken}`,
            },
          }
        : {}),
    });
  },
);

const mapModelError = (model: string, e: unknown): ModelCallFailed => {
  const message = e instanceof Error ? e.message : String(e);
  const status =
    typeof e === "object" && e !== null && "status" in e
      ? Number((e as { status?: unknown }).status)
      : Number.NaN;
  const reason: ModelCallFailed["reason"] =
    status === 401 || status === 403
      ? "auth-failed"
      : status === 429
        ? "rate-limited"
        : status === 408 || message.toLowerCase().includes("timeout")
          ? "timeout"
          : "unknown";
  return new ModelCallFailed({ model, reason, message });
};

const extractText = (response: Anthropic.Message): string => {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
};

const tryParseJson = (text: string): unknown => {
  // The model may wrap the JSON in ```json fences or include rationale before
  // the object; pull out the largest balanced JSON object.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  const candidate = body.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
};

const ACTION_SYSTEM_PROMPT = `You drive a web app through one user story.

You will see the story prose, the page's accessibility tree, and the history
of actions you have already applied. Pick ONE next action. Respond with a
SINGLE JSON object matching this discriminated union — no prose, no markdown
fences:

  { "type": "click",      "target": "<ax-node-id or selector>", "rationale": "..." }
  { "type": "type",       "target": "<ax-node-id or selector>", "text": "...", "rationale": "..." }
  { "type": "nav",        "url": "https://...", "rationale": "..." }
  { "type": "key",        "key": "Enter|Tab|Escape|...", "rationale": "..." }
  { "type": "wait",       "ms": 500, "rationale": "..." }
  { "type": "screenshot", "rationale": "this frame is the key moment for the story" }
  { "type": "done",       "narrative": "<2-4 sentence summary>", "status": "passed|failed" }

Rules:
- Prefer accessibility-tree node references (role + name) over CSS selectors.
- Emit ONE \`screenshot\` per story, at the moment that best captures the
  outcome (the dashboard after sign-in, the empty-state CTA after creating a
  project, etc.). The platform takes a final screenshot automatically; this
  marks the *key* frame.
- Stop ASAP. Return \`done\` as soon as the story's success condition is
  observable in the snapshot — do not pad with extra clicks.
- If the page is broken (500 error, locked-out account, unreachable element),
  return \`done\` with status \`failed\` and a narrative explaining why.
- Respect the time budget; if \`secsRemaining < 30\`, wrap up.
`;

const SUMMARY_SYSTEM_PROMPT = `You write the holistic walkthrough summary a
human reviewer pastes into a PR description. You will see the story results
and (optionally) the previous run's summary against the same deployed URL.

Write in **markdown**. Three sections:
1. **TL;DR** — 1-2 sentences on the overall outcome (X of Y stories passed).
2. **Per-story narratives** — one bullet per story, name in bold, the
   narrative from the agent verbatim, with the chapter offset and the
   screenshot link.
3. **What's new since last run** — only when a previous summary is supplied:
   diff highlights (resolved issues, new regressions, unchanged paths).
   Omit the section entirely otherwise.

Always end with the replay link as the last line: \`Replay: <replayUri>\`.
`;

const renderActionPrompt = (input: PickActionInput): string => {
  const history =
    input.history.length === 0
      ? "(no prior actions)"
      : input.history.map((h, i) => `${i + 1}. ${h}`).join("\n");
  return [
    `Story prose:\n${input.prose}`,
    `Time budget remaining: ${input.secsRemaining}s`,
    `Prior actions:\n${history}`,
    `Page accessibility snapshot:\n${input.snapshot}`,
    "Reply with ONE JSON action object.",
  ].join("\n\n");
};

const renderSummaryPrompt = (input: SummarizeInput): string => {
  const previousBlock =
    input.previous === undefined || input.previous.trim() === ""
      ? "(no previous run)"
      : input.previous;
  return [
    "Stories (JSON):",
    JSON.stringify(input.stories, null, 2),
    `Replay link: ${input.replayUri}`,
    `Replay JSON: ${input.replayJsonUri}`,
    "Previous summary:",
    previousBlock,
    "Write the markdown summary per the system prompt.",
  ].join("\n\n");
};
