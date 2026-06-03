// `product-demo` — AI-driven product demo run.
//
// A team hands it a deployed URL (preview / staging / prod) and a list of
// user stories as prose; the run drives the site through each story in
// sequence over a single CDP session with Browser Run's native rrweb
// session recording enabled, captures key screenshots, writes a per-story
// narrative, and then produces a holistic markdown summary across all
// stories that a reviewer can paste into the PR.
//
// Stories arrive in one of two shapes (provide exactly one):
//   - `stories`        — the structured `{ name, prose }[]` array.
//   - `storiesMarkdown` — a markdown doc where each `## ` heading is one
//     story (heading = name, body = prose). See `parseStoriesMarkdown`.
//     Lets an operator keep the demo script as a readable `.md` and edit it
//     like documentation rather than hand-maintaining JSON.
//
// No checkout — the target is a deployed URL, not the repo. The run only
// attaches to Browser Run over CDP and shells out to the bundled
// `demo-agent` CLI (baked into the `flare-dispatch-demo:latest` image, the
// same shape as `review-agent` in recipes/ai-code-review). The agent owns
// the model loop and CDP action application; the platform owns recording
// (Browser Run records rrweb DOM events at the session level when the CDP
// connect URL carries `?recording=true`); this run only orchestrates:
// attach → record start (set viewport, capture sessionId) → for each
// story play → record stop (close session, pull rrweb events from the
// Browser Run REST API, upload as R2 JSON) → summarize.
//
// Modes:
// - **Action** — dispatched by recipes/product-demo/ci.yml on `pull_request`
//   and on manual `workflow_dispatch`. See specs/04-gha-integration.md
//   § Action mode.
// - **Schedule** — fires daily via the `schedules[]` block below; the
//   Dispatcher's `scheduled()` handler routes the cron tick to this run.
//   Operators pre-bake the default story list + deployed URL in
//   `schedules[].inputs`. See specs/04-gha-integration.md § Schedule mode.
//
// DSL: uses `browser.newCDPSession`, `sandbox.exec`, `artifact.upload`,
//      `config.get`, and `io.priorExecution` — specs/03-dsl.md § Capabilities.

import { Effect, Schema, Option } from "effect";
import {
  defineRun,
  step,
  sandbox,
  browser,
  artifact,
  config,
  io,
  ExecFailed,
  ExecTimeout,
} from "@flare-dispatch/core";
import { loadSecrets } from "@flare-dispatch/core/primitives";

// Shell single-quote a value so arbitrary story prose (quotes, URLs, `!`, `$`)
// survives being embedded in the detached `sh -c` command below.
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Poll a `DONE:<exit>` sentinel file written by a detached process, with the
 * same transient-`ExecFailed` tolerance as runs/cdp-acceptance.ts: a poll
 * `cat` whose container connection is killed says nothing about the detached
 * process (which keeps running), so swallow it and keep polling; only a run of
 * killed polls (a genuinely dead container) re-surfaces the failure. Uses the
 * ambient sandbox (product-demo holds no `Container` handle).
 */
const pollSentinel = ({
  sentinel,
  maxAttempts,
  pollEverySec = 5,
  maxConsecutiveExecFailures = 12,
}: {
  readonly sentinel: string;
  readonly maxAttempts: number;
  readonly pollEverySec?: number;
  readonly maxConsecutiveExecFailures?: number;
}) =>
  Effect.gen(function* () {
    let consecutive = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const polled = yield* sandbox
        .exec({ command: `cat ${sentinel} 2>/dev/null || true` })
        .pipe(
          Effect.map((r) => Option.some(r.stdout)),
          Effect.catchTag("ExecFailed", () =>
            Effect.logWarning(
              `play-wait: poll exec killed (transient, ${consecutive + 1}/${maxConsecutiveExecFailures}), continuing`,
            ).pipe(Effect.as(Option.none<string>())),
          ),
        );
      if (Option.isNone(polled)) {
        consecutive += 1;
        if (consecutive >= maxConsecutiveExecFailures) {
          return yield* Effect.fail(
            new ExecFailed({
              exitCode: -1,
              stderrTail: `play-wait: ${maxConsecutiveExecFailures} consecutive poll execs killed — container appears dead`,
            }),
          );
        }
        yield* Effect.sleep(`${pollEverySec} seconds`);
        continue;
      }
      consecutive = 0;
      const match = /DONE:(-?\d+)/.exec(polled.value);
      if (match) return Number(match[1]);
      yield* Effect.sleep(`${pollEverySec} seconds`);
    }
    return yield* Effect.fail(
      new ExecTimeout({
        timeoutSec: 0,
        command: `play-wait: sentinel ${sentinel} never appeared after ${maxAttempts} polls`,
      }),
    );
  });

// A user story is just a name + prose. The agent reads the prose, decides
// the next browser action, applies it over the live CDP session, captures
// screenshots, and emits a narrative. Names must be unique within the
// `stories` array — they become chapter markers on the rrweb replay timeline.
const Story = Schema.Struct({
  name: Schema.String,
  prose: Schema.String,
});

/**
 * Parse a markdown stories document into the run's `{ name, prose }` list.
 *
 * Authoring contract — **each level-2 ATX heading (`## `) is one story**:
 *   - the heading text (trimmed, any trailing `#` stripped) becomes the
 *     story `name`;
 *   - every line from that heading down to the next `## ` (or EOF) becomes
 *     the `prose`, trimmed. Deeper headings (`###`+) are kept verbatim as
 *     part of the enclosing story's prose.
 * Content before the first `## ` — a `# Title`, a preamble paragraph — is
 * ignored, so an author can open the doc with context the agent never sees.
 *
 * This is the markdown counterpart to the structured `stories` array: it lets
 * an operator keep the demo script as a readable `.md` (one heading per
 * journey step) instead of hand-maintaining JSON. The dispatch passes the raw
 * file as `storiesMarkdown`; the run parses it here so the `demo-agent`
 * contract (`{ name, prose }`) is unchanged.
 *
 * Pure + deterministic (no Date / random / I/O) so it is safe in a run body
 * and unit-testable without a runtime.
 */
export const parseStoriesMarkdown = (
  markdown: string,
): ReadonlyArray<{ name: string; prose: string }> => {
  // Level-2 ATX only: `##` + whitespace + text. `##\s+` cannot match `###…`
  // (the char after `##` would be `#`, not whitespace), so deeper headings
  // fall through into the current story's prose. Up to 3 leading spaces are
  // tolerated per the CommonMark ATX rule.
  const headingRe = /^ {0,3}##\s+(.+?)\s*#*\s*$/;
  const stories: Array<{ name: string; prose: string[] }> = [];
  let current: { name: string; prose: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = headingRe.exec(line);
    if (match) {
      // Group 1 always present when `match` is truthy — the pattern requires it.
      current = { name: match[1]!.trim(), prose: [] };
      stories.push(current);
      continue;
    }
    if (current) current.prose.push(line);
  }
  return stories.map((s) => ({
    name: s.name,
    prose: s.prose.join("\n").trim(),
  }));
};

const Input = Schema.Struct({
  // The deployed URL the demo runs against. No checkout — this is the
  // target site, not the repo. `repo` and `sha` are still required because
  // the check-run callback anchors to them (specs/04-gha-integration.md
  // § Check-runs callback).
  repo: Schema.String,
  sha: Schema.String,
  deployedUrl: Schema.String,
  // Two ways to supply the story script — provide exactly one:
  //   - `stories`: the structured `{ name, prose }[]` list (the original
  //     contract; what `schedules[].inputs` and the recipe `ci.yml` pass).
  //   - `storiesMarkdown`: a markdown doc where each `## ` heading is one
  //     story (see `parseStoriesMarkdown`). Lets an operator keep the demo
  //     script as a readable `.md` instead of hand-rolled JSON.
  // If both are present, `stories` wins. The run resolves the effective list
  // and dies loudly on a payload with neither (see § "resolve stories").
  stories: Schema.optional(Schema.Array(Story)),
  storiesMarkdown: Schema.optional(Schema.String),
  // The viewport preset is passed through to the agent — it sets the CDP
  // viewport once at attach time via Emulation.setDeviceMetricsOverride so
  // every rrweb event in the session uses one resolution. Default desktop;
  // "mobile" emulates a phone profile in the agent.
  viewportPreset: Schema.optional(Schema.Literal("desktop", "mobile")),
  // Per-story wall-clock ceiling. Stories run sequentially against ONE
  // rrweb-recorded session so the replay timeline is continuous; without
  // a per-story cap one stuck story would burn the whole run's
  // `maxDurationSec`.
  maxDurationSecPerStory: Schema.optional(Schema.Number),
});

// Each story round-trips its own per-chapter record so the summary can
// point a reviewer at the exact span of the rrweb replay to look at.
const StoryResult = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("passed", "failed"),
  durationMs: Schema.Number,
  // rrweb timestamps in ms from session start — a reviewer can jump straight
  // to a story's chapter in the replay player by seeking to chapterStartMs.
  chapterStartMs: Schema.Number,
  chapterEndMs: Schema.Number,
  narrative: Schema.String,
  keyScreenshotUri: Schema.String,
});

const Output = Schema.Struct({
  // The docs-site rrweb player URL (https://<docsBase>/replay/<sessionId>).
  // Reviewers click through to scrub the recording. The replay UI itself
  // ships separately — see specs/pm/plan.md § Replay UI; until then this
  // links to a "coming soon" page that displays the raw replayJsonUri.
  replayUri: Schema.String,
  // Signed R2 URL to the raw rrweb event JSON (30-day TTL). Power-user
  // escape hatch — drop into an rrweb-player iframe to self-host the
  // replay. The dispatcher mirrors Browser Run's 30-day retention.
  replayJsonUri: Schema.String,
  summaryMd: Schema.String,       // the holistic LLM-written summary
  stories: Schema.Array(StoryResult),
});

export const productDemo = defineRun({
  name: "product-demo",
  version: "1.0.0",
  // The operator's sandbox image (the one bound to `RUNS_SANDBOX` via
  // `wrangler.jsonc`) MUST include the `demo-agent` binary on PATH — model
  // loop, CDP-driver glue, and the Browser Run recording REST client.
  // No `image:` field here: FlareDispatch has one container binding per
  // Worker; the image is pinned by `infra/Dockerfile.sandbox`. Drop the
  // `demo-agent` layer from `recipes/product-demo/Dockerfile.example` into
  // your own `Dockerfile.sandbox` to enable this run.
  inputs: Input,
  outputs: Output,
  // Stories run SEQUENTIALLY against one CDP session so the rrweb timeline
  // stays continuous. `maxConcurrency: 1` makes the sequencing explicit and
  // keeps the Browser Run session count to 1. `requiresBrowser: true`
  // reserves a slot in the Browser Run pool — and the dispatcher's
  // `newCDPSession` primitive appends `?recording=true` so Browser Run
  // captures the rrweb event stream for the session's lifetime.
  limits: { maxDurationSec: 3600, maxConcurrency: 1, requiresBrowser: true },

  // Schedule-mode binding — 14:00 UTC daily. The cron expression MUST also
  // appear in wrangler.jsonc `triggers.crons`. See specs/04-gha-integration.md
  // § Schedule mode. The dedup key is per-UTC-day so a duplicate Cron Trigger
  // delivery (or a same-day operator-triggered Worker recycle) collapses to
  // the original instance via CF Workflows' `create({ id })` no-op semantics.
  // OPERATOR: edit the inputs below to point at your tracking repo + your
  // deployed URL + your story list. Action-mode dispatches (via ci.yml) take
  // their inputs from the workflow_dispatch payload and ignore these defaults.
  schedules: [
    {
      cron: "0 14 * * *",
      idempotencyKey: ({ firedAt }) =>
        `product-demo-${new Date(firedAt).toISOString().slice(0, 10)}`,
      inputs: () => ({
        repo: "OWNER/REPO",
        sha: "main",
        deployedUrl: "https://staging.example.com",
        stories: [
          {
            name: "landing",
            prose:
              "Visit the homepage and verify the primary call-to-action is visible above the fold.",
          },
        ],
        viewportPreset: "desktop" as const,
      }),
    },
  ],

  run: (input) =>
    Effect.gen(function* () {
      const viewport = input.viewportPreset ?? "desktop";
      const perStorySec = input.maxDurationSecPerStory ?? 180;

      // -1. Resolve the effective story list BEFORE any browser/sandbox work,
      //     so a misconfigured payload dies cheaply (no CDP session leaked, no
      //     image pull). `stories` wins over `storiesMarkdown`; the markdown is
      //     parsed into the same `{ name, prose }` shape the rest of the run
      //     (and `demo-agent`) consumes, so nothing downstream is markdown-aware.
      const resolvedStories =
        input.stories !== undefined && input.stories.length > 0
          ? input.stories
          : input.storiesMarkdown !== undefined
            ? parseStoriesMarkdown(input.storiesMarkdown)
            : [];
      if (resolvedStories.length === 0) {
        // A demo with no stories is never what the operator meant — a typo in
        // the markdown headings or a forgotten `stories` array. Die loudly.
        return yield* Effect.die(
          "product-demo: no stories to play — supply a non-empty `stories` array, " +
            "or a `storiesMarkdown` doc with at least one `## ` heading.",
        );
      }
      const duplicateNames = [
        ...new Set(
          resolvedStories
            .map((s) => s.name)
            .filter((n, i, a) => a.indexOf(n) !== i),
        ),
      ];
      if (duplicateNames.length > 0) {
        // Names become rrweb chapter markers — duplicates would collide on the
        // replay timeline and in the per-story result map.
        return yield* Effect.die(
          `product-demo: duplicate story names ${JSON.stringify(duplicateNames)} — ` +
            "each story name becomes a unique rrweb chapter marker.",
        );
      }

      // 0. Resolve the demo-agent's runtime credentials from CONFIG_KV. The
      //    container holds NO ambient credentials — every `sandbox.exec` is
      //    explicit about which env vars cross the boundary. The agent's
      //    model transport is provider-agnostic (built on `@effect/ai`'s
      //    `LanguageModel` Tag over the OpenAI wire protocol) and always routes
      //    through a Cloudflare AI Gateway; the operator picks the upstream by
      //    what they configure on the gateway.
      //      * `CF_AI_GATEWAY_ID`       — the gateway slug. The agent derives
      //        the endpoint as
      //        `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`
      //        from this + `CLOUDFLARE_ACCOUNT_ID` (no `MODEL_BASE_URL`).
      //      * `CLOUDFLARE_ACCOUNT_ID`  — account that owns the gateway AND the
      //        Browser Rendering session; both the model URL and the recorder
      //        REST URL key off this.
      //      * `CLOUDFLARE_API_TOKEN`   — same token shape as
      //        `BROWSER_CDP_API_TOKEN` on the Worker. Authorises the
      //        recording REST fetch.
      //      * `MODEL_API_KEY` (optional) — UPSTREAM provider key, sent as
      //        `Authorization: Bearer`. Set only to go around BYOK; empty /
      //        unset is fine for the BYOK-via-gateway path.
      //      * `CF_AI_GATEWAY_TOKEN` (optional) — the gateway's OWN auth
      //        ("Authenticated Gateway"), sent as `cf-aig-authorization`.
      //        Orthogonal to `MODEL_API_KEY`; set only when the gateway is
      //        locked down.
      //    All keys live under `product-demo.secret/` so the operator can
      //    namespace them away from feature-flag keys.
      const requiredAgentEnv = yield* loadSecrets(
        ["CF_AI_GATEWAY_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
        { prefix: "product-demo.secret/", required: true },
      );
      const optionalAgentEnv = yield* loadSecrets(
        ["MODEL_API_KEY", "CF_AI_GATEWAY_TOKEN"],
        { prefix: "product-demo.secret/" },
      );
      // Optional CF Access service token — when the `deployedUrl` sits behind
      // Cloudflare Access (the numu staging Pages site 302s to the Access login
      // otherwise), demo-agent sets these as extra HTTP headers so the browser
      // gets past the wall. Reuses the same `staging/CF_ACCESS_*` keys that
      // cdp-acceptance/playwright-demo already use. Absent ⇒ a public target.
      const cfAccessEnv = yield* loadSecrets(
        ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"],
        { prefix: "staging/" },
      );
      const agentEnv = {
        ...requiredAgentEnv,
        ...optionalAgentEnv,
        ...cfAccessEnv,
      };

      // 1. Attach Browser Run over CDP against the DEPLOYED URL. No
      //    checkout, no app boot — the site is already live. The dispatcher's
      //    `newCDPSession` primitive composes the connect URL with
      //    `?recording=true` so Browser Run records rrweb DOM events for
      //    the whole session; the agent doesn't have to start recording —
      //    it inherits a session that's already recording.
      // Persist ONLY the `wsEndpoint` string, not the whole `CDPSession`: the
      // session carries a `close` Effect, and a CF Workflow checkpoint cannot
      // structured-clone an Effect (`DataCloneError: … EffectPrimitiveSuccess`)
      // — every `step` return value is durably checkpointed. The container is
      // torn down at run end, so the endpoint the demo-agent dials is all we
      // need across the step boundary. Same fix as runs/cdp-acceptance.ts.
      const cdpWsUrl = yield* step("attach-cdp", () =>
        browser
          .newCDPSession({ targetUrl: input.deployedUrl })
          .pipe(Effect.map((session) => session.wsEndpoint)),
      );

      // Filesystem layout inside the container — relative paths the agent
      // writes through. The session-id file is the handoff between
      // `record-start` (which queries it via puppeteer.sessionId()) and
      // `record-stop` (which uses it to call Browser Run's recording REST
      // endpoint after the session closes).
      const sessionIdPath = "/tmp/demo/session-id";
      const replayJsonPath = "/tmp/demo/replay.json";
      const screenshotsDir = "/tmp/demo/screenshots";
      const storiesJsonPath = "/tmp/demo/stories.json";
      const summaryPath = "/tmp/demo/summary.md";

      // 2. Validate the connect URL carries `?recording=true`, set the
      //    viewport once (one resolution for the whole rrweb stream), and
      //    capture the session ID for the REST pull in step 4. The agent
      //    does NOT start a recording pipeline of its own — Browser Run is
      //    already recording on the platform side.
      yield* step("record-start", () =>
        sandbox.exec({
          command: [
            "demo-agent", "record", "start",
            "--cdp-ws", cdpWsUrl,
            "--viewport", viewport,
            "--session-id-out", sessionIdPath,
            // Navigate the session to the app under test up front (the browser
            // is on about:blank otherwise — newCDPSession doesn't navigate).
            "--url", input.deployedUrl,
          ],
          env: agentEnv,
        }),
      );

      // 2.5. Resolve the per-step model ids through the control plane — same
      //      seam as `pr-review` (recipes/ai-code-review): an operator can
      //      repoint `product-demo.model.play` / `.summary` in CONFIG_KV
      //      without redeploying, and a `play` model that's smaller than the
      //      summariser keeps token spend down. Both keys are REQUIRED — no
      //      provider-specific default lives in code (a default like
      //      `claude-opus-4-7` would only work on a gateway routed to
      //      Anthropic; `gpt-4o` only on OpenAI; there is no universal id).
      //      An unset key is a misconfigured deploy and we die loudly.
      const playModel = yield* step("resolve-play-model", () =>
        config.get("product-demo.model.play").pipe(
          Effect.flatMap((v) =>
            v !== undefined && v !== ""
              ? Effect.succeed(v)
              : Effect.die(
                  "CONFIG_KV missing required key: product-demo.model.play (e.g. `gpt-4o`, `claude-opus-4-7`, `@cf/meta/llama-3.1-70b-instruct`)",
                ),
          ),
        ),
      );

      // 3. Walk the stories in order. Each `demo-agent play` reads the
      //    prose, applies actions over the SAME CDP session (so the rrweb
      //    timeline stays continuous), captures key screenshots into
      //    `screenshotsDir`, and emits one JSON line per story with the
      //    chapter offsets (rrweb timestamps), status, narrative, and the
      //    key-screenshot path. Concurrency 1 — see `limits` above.
      // Each `demo-agent play` is a MULTI-MINUTE run (the model drives the
      // browser action-by-action). A blocking `sandbox.exec` held that long has
      // its container connection killed by the CF Sandbox (~10-20s) and fails
      // `ExecFailed` before the story finishes — so launch DETACHED and poll a
      // sentinel, exactly like runs/cdp-acceptance.ts's test command. stdout
      // (the result JSON) + stderr go to per-story files that survive the
      // detach; stderr is collected for debugging via `upload-play-logs` below.
      // Each story is its OWN durable step so it stays under CF Workflows'
      // ~10-min per-`step.do` ceiling — one step wrapping all stories (the
      // render-waiting "generate-creatives" can take ~5 min by itself) blew
      // that 600s cap. The instance itself can run far longer (maxDurationSec).
      const playResults = yield* Effect.forEach(
        resolvedStories,
        (story, i) =>
          step(`play-${i}`, () =>
              Effect.gen(function* () {
                // BLOCKING exec (array command — no shell, no escaping). On a
                // stable container (standard-4+) the exec connection survives
                // the multi-minute play and returns the result JSON directly.
                // Detached+sentinel-poll was unreliable here: the ambient
                // sandbox serialises execs, so the poll's `cat` queues behind
                // the still-running detached play and never reads its sentinel,
                // spinning the step to CF Workflows' ~10-min cap. `timeoutSec`
                // bounds the exec; `--max-sec` is the agent's own budget.
                const result = yield* sandbox.exec({
                  command: [
                    "demo-agent",
                    "play",
                    "--cdp-ws",
                    cdpWsUrl,
                    "--name",
                    story.name,
                    "--prose",
                    story.prose,
                    "--screenshots",
                    screenshotsDir,
                    "--max-sec",
                    String(perStorySec),
                    "--model",
                    playModel,
                    // Navigate to the app if the page is still blank (the first
                    // story, or if record-start's nav didn't carry over).
                    "--url",
                    input.deployedUrl,
                  ],
                  env: agentEnv,
                  // Headroom over the agent's `--max-sec` so the loop can
                  // self-abort after a final (≤45s-bounded) action and RETURN a
                  // result, instead of the exec timing out (ExecTimeout) first.
                  timeoutSec: perStorySec + 90,
                });
                if (result.exitCode !== 0 || result.stdout.trim() === "") {
                  yield* io.log(
                    "warn",
                    `play '${story.name}' exit=${result.exitCode} stderrTail=${result.stderr.slice(-800)}`,
                  );
                }
                return {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                };
              }),
            { retries: 0 },
          ).pipe(
            // Hard wall-clock bound per story step, BELOW CF Workflows' ~10-min
            // per-`step.do` cap: if the detached play never writes its sentinel
            // (a hung exec the inner timeouts didn't catch), the step still
            // returns a failed result instead of being killed by CF — so the
            // run ALWAYS reaches `record-stop`/`summarize`, posts a verdict, and
            // uploads the play logs for debugging.
            Effect.timeoutTo({
              duration: "8 minutes",
              onSuccess: (r: { stdout: string; stderr: string; exitCode: number }) =>
                r,
              onTimeout: () => ({
                stdout: "",
                stderr: "play step exceeded its 8-minute wall-clock budget",
                exitCode: -2,
              }),
            }),
            Effect.catchAll((cause) =>
              Effect.succeed({
                stdout: "",
                stderr: `play step failed: ${String(cause)}`,
                exitCode: -3,
              }),
            ),
          ),
        { concurrency: 1 },
      );

      // Collect every story's stderr into one signed-R2 artifact so a failed
      // play is debuggable from the check-run (the per-exec stderr is otherwise
      // lost when a run fails). Best-effort — never masks the verdict.
      yield* step("upload-play-logs", () =>
        Effect.gen(function* () {
          yield* sandbox.exec({
            command: `{ for f in /tmp/demo/play-*.out; do echo "=== $f (stdout) ==="; cat "$f"; done; for f in /tmp/demo/play-*.err; do echo "=== $f (stderr) ==="; cat "$f"; done; } > /tmp/demo/play-stderr.log 2>/dev/null || true`,
          });
          return yield* artifact
            .upload({
              name: "play-stderr.log",
              path: "/tmp/demo/play-stderr.log",
              contentType: "text/plain",
              signedUrlTTL: "30 days",
            })
            .pipe(Effect.catchAll(() => Effect.succeed("")));
        }),
      );

      // 4. Close the CDP session and pull the recording. Browser Run only
      //    finalizes rrweb events after the session closes; `demo-agent
      //    record stop` closes the session, polls
      //    GET /accounts/<id>/browser-rendering/recording/<sessionId>, writes
      //    the event array to `--out`, and emits a JSON last-line with the
      //    sessionId + the realized event count.
      const recordStopResult = yield* step("record-stop", () =>
        sandbox.exec({
          command: [
            "demo-agent", "record", "stop",
            "--cdp-ws", cdpWsUrl,
            "--session-id-in", sessionIdPath,
            "--out", replayJsonPath,
          ],
          env: agentEnv,
        }),
      );

      // 5. Parse each `play` step's JSON stdout. The agent's contract: one
      //    JSON object per invocation on the LAST line of stdout (anything
      //    before is logs). The shape is fixed by the agent — mirrors the
      //    `review-agent coordinate --json` pattern in recipes/ai-code-review.
      type PlayJson = {
        status: "passed" | "failed";
        durationMs: number;
        chapterStartMs: number;
        chapterEndMs: number;
        narrative: string;
        keyScreenshotPath: string;
      };
      // `playResults` is the result of `Effect.forEach(resolvedStories, …)`
      // so `playResults.length === resolvedStories.length`; iterate the
      // resolved array directly to keep `story` typed (not `… | undefined`).
      // Parse the agent's last JSON line DEFENSIVELY: a story whose detached
      // process wrote nothing parseable (a crash, an empty capture) must mark
      // that ONE story failed — never throw and sink the whole run after the
      // expensive play loop already succeeded.
      const parseLastJson = <T>(stdout: string, fallback: T): T => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        if (lastLine === "") return fallback;
        try {
          return JSON.parse(lastLine) as T;
        } catch {
          return fallback;
        }
      };
      const parsed = resolvedStories.map((story, i) => {
        const result = playResults[i] as {
          stdout: string;
          stderr: string;
          exitCode: number;
        };
        const json = parseLastJson<PlayJson>(result.stdout, {
          status: "failed",
          durationMs: 0,
          chapterStartMs: 0,
          chapterEndMs: 0,
          narrative: `play produced no parseable result (exit ${result.exitCode}). stderr tail: ${result.stderr.slice(-400)}`,
          keyScreenshotPath: "",
        });
        return { story, json };
      });

      type RecordStopJson = { sessionId: string; eventCount: number };
      const recordStopJson = parseLastJson<RecordStopJson>(
        recordStopResult.stdout,
        { sessionId: "", eventCount: 0 },
      );

      // 6. Upload the rrweb event JSON once, signed for 30 days so the link
      //    survives PR-review cycles. Reviewers paste the URL straight into
      //    the PR description, or feed it to an rrweb-player iframe.
      // Best-effort: a long recorded session can produce a replay.json large
      // enough to blow the Worker's CPU-time limit on upload. The replay is a
      // debugging bonus, not the verdict — never let it sink a run whose stories
      // already played. Empty URI on failure; the summary just omits the link.
      const replayJsonUri = yield* step("upload-replay-json", () =>
        artifact
          .upload({
            name: "replay.json",
            path: replayJsonPath,
            contentType: "application/json",
            signedUrlTTL: "30 days",
          })
          .pipe(
            Effect.catchAll(() =>
              io.log("warn", "upload-replay-json failed; continuing").pipe(
                Effect.as(""),
              ),
            ),
          ),
      );

      // 7. Upload each story's key screenshot in parallel (concurrency 4
      //    — independent uploads, no shared state). Each returns its own
      //    signed URL embedded into the per-story result.
      const screenshotUris = yield* step("upload-screenshots", () =>
        Effect.forEach(
          parsed,
          (p) =>
            // A failed story may have captured no key screenshot — skip the
            // upload (and tolerate an upload error) rather than fail the run.
            p.json.keyScreenshotPath === ""
              ? Effect.succeed("")
              : artifact
                  .upload({
                    name: `${p.story.name}.png`,
                    path: p.json.keyScreenshotPath,
                    contentType: "image/png",
                    signedUrlTTL: "30 days",
                  })
                  .pipe(Effect.catchAll(() => Effect.succeed(""))),
          { concurrency: 4 },
        ),
      );

      // 8. Resolve the summary model id (required, same shape as
      //    `product-demo.model.play` above) and the docs-site base. Docs
      //    base IS tuning, not gating, so it keeps a default; the model id
      //    has no provider-neutral default and dies loudly when unset.
      const summaryModel = yield* step("resolve-summary-model", () =>
        config.get("product-demo.model.summary").pipe(
          Effect.flatMap((v) =>
            v !== undefined && v !== ""
              ? Effect.succeed(v)
              : Effect.die(
                  "CONFIG_KV missing required key: product-demo.model.summary",
                ),
          ),
        ),
      );
      const docsBase = yield* step("resolve-docs-base", () =>
        config.get("product-demo.docsBase").pipe(
          Effect.map(
            (override) => override ?? "https://flare-dispatch.openhackersclub.com",
          ),
        ),
      );
      const replayUri = `${docsBase}/replay/${recordStopJson.sessionId}`;

      // 9. Stitch typed per-story results, then write them to disk for the
      //    agent's summarizer. Doing the file write through `sandbox.exec`
      //    keeps everything inside the container — the agent and the file
      //    sit on the same filesystem.
      const stories = parsed.map((p, i) => ({
        name: p.story.name,
        status: p.json.status,
        durationMs: p.json.durationMs,
        chapterStartMs: p.json.chapterStartMs,
        chapterEndMs: p.json.chapterEndMs,
        narrative: p.json.narrative,
        // `screenshotUris.length === parsed.length` — Effect.forEach over `parsed`.
        keyScreenshotUri: screenshotUris[i]!,
      }));
      yield* step("write-stories-json", () =>
        sandbox.exec({
          command: [
            "demo-agent", "write-json",
            "--out", storiesJsonPath,
            "--data", JSON.stringify({ stories, replayUri, replayJsonUri }),
          ],
          env: agentEnv,
        }),
      );

      // 10. Load the previous execution for this (repo, deployedUrl) so
      //     `summarize` can call out what's new / regressed since the last
      //     demo run. `Option.match` — never `_tag` access (CLAUDE.md
      //     Effect-TS rules).
      const prior = yield* step("load-prior", () =>
        io.priorExecution({
          family: `product-demo:${input.repo}:${input.deployedUrl}`,
          outputSchema: Output,
        }),
      );

      // 11. Hand the previous summary to the agent as a file IF it exists.
      //     Seeding via an intermediate file (instead of `--previous-json
      //     '<...>'`) avoids ARG_MAX surprises when the prior summary is
      //     long-form prose.
      const previousArgs = yield* Option.match(prior, {
        onNone: () => Effect.succeed<readonly string[]>([]),
        onSome: (p) =>
          step("seed-prior", () =>
            sandbox.exec({
              command: [
                "demo-agent", "write-prior",
                "--out", "/tmp/demo/previous.md",
                "--data", p.output.summaryMd,
              ],
              env: agentEnv,
            }).pipe(Effect.as(["--previous", "/tmp/demo/previous.md"] as const)),
          ),
      });

      // 12. Generate the holistic summary. The agent emits the markdown to
      //     stdout AND writes it to `--out`; we read it from stdout because
      //     `io` has no file-read primitive — see specs/03-dsl.md § io.
      // Best-effort: a summariser failure (model hiccup, exec kill) must not
      // sink a run whose stories already played — fall back to a minimal
      // machine-written summary so the run still returns a verdict.
      const summaryMd = yield* step("summarize", () =>
        sandbox
          .exec({
            command: [
              "demo-agent", "summarize",
              "--stories-json", storiesJsonPath,
              "--model", summaryModel,
              "--out", summaryPath,
              ...previousArgs,
            ],
            env: agentEnv,
          })
          .pipe(
            Effect.map((r) => r.stdout.trim()),
            Effect.catchAll(() =>
              Effect.succeed(
                `# Demo summary\n\n${stories.length} stories, ${stories.filter((s) => s.status === "passed").length} passed. (Automated summary generation failed — see per-story narratives.)`,
              ),
            ),
          ),
      );

      yield* io.log(
        "info",
        `product-demo: ${stories.length} stories, ${stories.filter((s) => s.status === "passed").length} passed, ${recordStopJson.eventCount} rrweb events`,
      );

      // The check-run summary the Dispatcher posts EMBEDS `summaryMd`
      // verbatim and links `replayUri` — reviewers see the holistic write-up
      // on the PR's Checks tab and one signed replay link they can drop
      // straight into the PR description (see specs/04-gha-integration.md
      // § Inline findings — summary).
      return {
        replayUri,
        replayJsonUri,
        summaryMd,
        stories,
      };
    }),
});
