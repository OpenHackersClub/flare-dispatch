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
  AcceptanceFailed,
  type Container,
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
 * killed polls (a genuinely dead container) re-surfaces the failure. Threads
 * the EXPLICIT acquired `container` handle (see run body) — the same fix that
 * makes runs/cdp-acceptance.ts reliable: the ambient sandbox SERIALISES execs,
 * so a poll `cat` queues behind the still-running detached play and never reads
 * the sentinel; an explicit container handle runs the poll as its own short
 * connection while the detached play keeps running in the background.
 */
const pollSentinel = ({
  container,
  sentinel,
  maxAttempts,
  pollEverySec = 5,
  maxConsecutiveExecFailures = 12,
}: {
  readonly container: Container;
  readonly sentinel: string;
  readonly maxAttempts: number;
  readonly pollEverySec?: number;
  readonly maxConsecutiveExecFailures?: number;
}) =>
  Effect.gen(function* () {
    let consecutive = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const polled = yield* sandbox
        .exec({ container, command: `cat ${sentinel} 2>/dev/null || true` })
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
  // Each story now records on its OWN CDP session (the run plays stories in
  // parallel), so the replay links are per-story, not one shared timeline.
  replayUri: Schema.String,
  replayJsonUri: Schema.String,
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
  // Stories run IN PARALLEL, each on its own Browser Run CDP session (own
  // rrweb recording) — see the run body's per-story `playStory`. `requiresBrowser`
  // reserves a Browser Run slot, and the dispatcher's `newCDPSession` primitive
  // appends `?recording=true` so each session captures its own rrweb stream.
  // `maxConcurrency: 1` is the RUN-level limit (one product-demo execution at a
  // time); per-story concurrency is capped inside the run.
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

      // 0. Acquire ONE explicit container and thread its handle through every
      //    `sandbox.exec` / `runDetached` / poll below. This is the structural
      //    fix that makes the run reliable (mirrors runs/cdp-acceptance.ts,
      //    which threads the `workspace()` container): the AMBIENT sandbox
      //    serialises execs against the execution-scoped box, so a detached
      //    multi-minute play blocks every subsequent `cat` poll behind it (the
      //    sentinel is never read → the step spins to CF Workflows' ~10-min
      //    cap), while a blocking play holds one connection long enough to be
      //    killed (ExecFailed). An explicit, persistent container handle lets
      //    the play run detached in the background while short poll execs read
      //    its sentinel on their own connections. No repo checkout — unlike
      //    cdp-acceptance we run the baked `demo-agent` against a live URL, so
      //    `acquire` (not `workspace`) is the right primitive.
      const container = yield* step("acquire", () => sandbox.acquire({}));

      // 1. Resolve config-store knobs ONCE for the whole run: the per-story
      //    play model + the replay docs base. Read before any browser work so a
      //    misconfigured deploy dies cheaply. (No summary model — the holistic
      //    summary is now built deterministically in-run as markdown below, so
      //    there is no second LLM round-trip and no fragile stories.json file.)
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
      const docsBase = yield* step("resolve-docs-base", () =>
        config.get("product-demo.docsBase").pipe(
          Effect.map(
            (override) => override ?? "https://flare-dispatch.openhackersclub.com",
          ),
        ),
      );

      const screenshotsDir = "/tmp/demo/screenshots";

      // Defensive parse of an agent's last JSON stdout line — one bad story
      // marks itself failed, never throws and sinks the run.
      const parseLastJson = <T>(stdout: string, fallback: T): T => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        if (lastLine === "") return fallback;
        try {
          return JSON.parse(lastLine) as T;
        } catch {
          return fallback;
        }
      };
      type PlayJson = {
        status: "passed" | "failed";
        durationMs: number;
        chapterStartMs: number;
        chapterEndMs: number;
        narrative: string;
        keyScreenshotPath: string;
      };
      type RecordStopJson = { sessionId: string; eventCount: number };
      type StoryOutcome = {
        name: string;
        status: "passed" | "failed";
        durationMs: number;
        chapterStartMs: number;
        chapterEndMs: number;
        narrative: string;
        keyScreenshotUri: string;
        replayUri: string;
        replayJsonUri: string;
      };

      // 2. Play every story IN PARALLEL, each on its OWN Browser Rendering CDP
      //    session — so each story gets an independent rrweb recording + replay,
      //    its own detached play process, and its own attach → record-start →
      //    play → record-stop pipeline. This is the in-run-parallel design: one
      //    workflow + one container, N concurrent self-contained stories. Each
      //    story's full cycle stays well under CF Workflows' ~600s per-`step.do`
      //    cap, and a slow/stuck story can't starve the others (no shared
      //    session, no first-play serialisation). The detached plays overlap in
      //    the background while short poll/cat execs read their sentinels, so
      //    the expensive work is genuinely concurrent even on one container.
      //    Concurrency is capped so we don't exhaust the Browser Rendering
      //    session pool or the container CPU; extra stories queue.
      const PER_STORY_CONCURRENCY = 3;

      const playStory = (story: { name: string; prose: string }, i: number) =>
        Effect.gen(function* () {
          const sessionIdPath = `/tmp/demo/session-${i}`;
          const replayJsonPath = `/tmp/demo/replay-${i}.json`;
          const outPath = `/tmp/demo/play-${i}.out`;
          const errPath = `/tmp/demo/play-${i}.err`;
          const sentinelPath = `/tmp/demo/play-${i}.done`;

          // attach — this story's OWN recording session.
          const cdpWsUrl = yield* step(`attach-cdp-${i}`, () =>
            browser
              .newCDPSession({ targetUrl: input.deployedUrl })
              .pipe(Effect.map((session) => session.wsEndpoint)),
          );

          // record-start — navigate to the app + capture this session's id.
          yield* step(`record-start-${i}`, () =>
            sandbox.exec({
              container,
              command: [
                "demo-agent", "record", "start",
                "--cdp-ws", cdpWsUrl,
                "--viewport", viewport,
                "--session-id-out", sessionIdPath,
                "--url", input.deployedUrl,
              ],
              env: agentEnv,
            }),
          );

          // play — DETACHED + sentinel-poll (the reliable pattern; explicit
          // container), bounded so a hung play returns a failed result.
          const playResult = yield* step(
            `play-${i}`,
            () =>
              Effect.gen(function* () {
                const playArgv = [
                  "demo-agent", "play",
                  "--cdp-ws", cdpWsUrl,
                  "--name", story.name,
                  "--prose", story.prose,
                  "--screenshots", screenshotsDir,
                  "--max-sec", String(perStorySec),
                  "--model", playModel,
                  "--url", input.deployedUrl,
                ]
                  .map(shellQuote)
                  .join(" ");
                const detachedCmd =
                  `mkdir -p ${screenshotsDir}; ` +
                  `( timeout -s KILL ${perStorySec + 90} ${playArgv} > ${outPath} 2> ${errPath} ); ` +
                  `echo "DONE:$?" > ${sentinelPath}`;
                yield* sandbox.runDetached({
                  container,
                  command: detachedCmd,
                  env: agentEnv,
                });
                const exitCode = yield* pollSentinel({
                  container,
                  sentinel: sentinelPath,
                  maxAttempts: Math.ceil((perStorySec + 120) / 5),
                });
                const stdout = yield* sandbox
                  .exec({ container, command: `cat ${outPath} 2>/dev/null || true` })
                  .pipe(Effect.map((r) => r.stdout), Effect.catchAll(() => Effect.succeed("")));
                const stderr = yield* sandbox
                  .exec({ container, command: `cat ${errPath} 2>/dev/null || true` })
                  .pipe(Effect.map((r) => r.stdout), Effect.catchAll(() => Effect.succeed("")));
                return { stdout, stderr, exitCode };
              }),
            { retries: 0 },
          ).pipe(
            // Wall-clock bound below the ~600s per-step.do cap.
            Effect.timeoutTo({
              duration: "9 minutes",
              onSuccess: (r: { stdout: string; stderr: string; exitCode: number }) => r,
              onTimeout: () => ({
                stdout: "",
                stderr: "play step exceeded its wall-clock budget",
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
          );

          // record-stop — close THIS session + pull its rrweb recording.
          const recordStopResult = yield* step(`record-stop-${i}`, () =>
            sandbox
              .exec({
                container,
                command: [
                  "demo-agent", "record", "stop",
                  "--cdp-ws", cdpWsUrl,
                  "--session-id-in", sessionIdPath,
                  "--out", replayJsonPath,
                ],
                env: agentEnv,
              })
              .pipe(
                Effect.catchAll(() =>
                  Effect.succeed({
                    stdout: "",
                    stderr: "",
                    exitCode: 1,
                    durationMs: 0,
                    logPath: "",
                  }),
                ),
              ),
          );

          const pj = parseLastJson<PlayJson>(playResult.stdout, {
            status: "failed",
            durationMs: 0,
            chapterStartMs: 0,
            chapterEndMs: 0,
            narrative: `play produced no parseable result (exit ${playResult.exitCode}). stderr tail: ${playResult.stderr.slice(-400)}`,
            keyScreenshotPath: "",
          });
          const rs = parseLastJson<RecordStopJson>(recordStopResult.stdout, {
            sessionId: "",
            eventCount: 0,
          });

          // Per-story uploads (best-effort): the replay JSON + the key frame.
          const replayJsonUri = yield* step(`upload-replay-${i}`, () =>
            artifact
              .upload({
                name: `replay-${i}.json`,
                path: replayJsonPath,
                // `container` is REQUIRED — the runtime reads `path` from THIS
                // container's filesystem. Omitting it silently fails the upload
                // (caught below) so the artifact never lands in R2 — the cause
                // of the empty replay links / "replay is not a valid url".
                container,
                contentType: "application/json",
                signedUrlTTL: "30 days",
              })
              .pipe(Effect.catchAll(() => Effect.succeed(""))),
          );
          const keyScreenshotUri =
            pj.keyScreenshotPath === ""
              ? ""
              : yield* step(`upload-screenshot-${i}`, () =>
                  artifact
                    .upload({
                      name: `${story.name}.png`,
                      path: pj.keyScreenshotPath,
                      container,
                      contentType: "image/png",
                      signedUrlTTL: "30 days",
                    })
                    .pipe(Effect.catchAll(() => Effect.succeed(""))),
                );

          const replayUri =
            rs.sessionId !== "" ? `${docsBase}/replay/${rs.sessionId}` : "";

          yield* io.log(
            "info",
            `story '${story.name}': ${pj.status} (${rs.eventCount} rrweb events)`,
          );

          return {
            name: story.name,
            status: pj.status,
            durationMs: pj.durationMs,
            chapterStartMs: pj.chapterStartMs,
            chapterEndMs: pj.chapterEndMs,
            narrative: pj.narrative,
            keyScreenshotUri,
            replayUri,
            replayJsonUri,
          };
        }).pipe(
          // One story's INFRA failure (a failed attach, a dropped session)
          // must not sink the parallel run — mark that one story failed.
          Effect.catchAll((cause) =>
            Effect.succeed<StoryOutcome>({
              name: story.name,
              status: "failed",
              durationMs: 0,
              chapterStartMs: 0,
              chapterEndMs: 0,
              narrative: `story pipeline failed: ${String(cause)}`,
              keyScreenshotUri: "",
              replayUri: "",
              replayJsonUri: "",
            }),
          ),
        );

      const stories = yield* Effect.forEach(resolvedStories, playStory, {
        concurrency: PER_STORY_CONCURRENCY,
      });

      // 3. Build the holistic summary as MARKDOWN, in-run + deterministic — no
      //    second LLM call, no stories.json file to go missing across execs.
      const passedCount = stories.filter((s) => s.status === "passed").length;
      const summaryMd = [
        `# product-demo — ${passedCount}/${stories.length} chapters passed`,
        "",
        "| Chapter | Result | Replay | Notes |",
        "| --- | --- | --- | --- |",
        ...stories.map((s) => {
          const replay =
            s.replayUri !== ""
              ? `[replay](${s.replayUri})`
              : s.replayJsonUri !== ""
                ? `[rrweb json](${s.replayJsonUri})`
                : "—";
          const note = s.narrative.replace(/\n+/g, " ").slice(0, 200);
          return `| ${s.name} | ${s.status === "passed" ? "✅ pass" : "❌ fail"} | ${replay} | ${note} |`;
        }),
      ].join("\n");

      yield* io.log(
        "info",
        `product-demo: ${stories.length} stories, ${passedCount} passed`,
      );

      // The top-level replay points at the first story that produced one (the
      // structured per-story replays live in `stories[]`).
      const primary =
        stories.find((s) => s.replayUri !== "") ?? stories[0];

      // 3.5. Persist the markdown summary (with per-story narratives) as an
      //      artifact on BOTH the pass AND fail paths — so a FAILED run (whose
      //      `summary_json` the dispatcher discards on a failed Exit) is still
      //      diagnosable: fetch `artifacts/<execId>/summary.md` from R2. Without
      //      this, an honest red check hides WHY every chapter failed.
      //      Best-effort — never let a diagnostics upload change the verdict.
      yield* step("upload-summary", () =>
        sandbox
          .exec({
            container,
            command: `printf '%s' ${shellQuote(summaryMd)} > /tmp/demo/summary.md`,
          })
          .pipe(
            Effect.andThen(
              artifact.upload({
                name: "summary.md",
                path: "/tmp/demo/summary.md",
                container,
                contentType: "text/markdown",
                signedUrlTTL: "30 days",
              }),
            ),
            Effect.catchAll(() => Effect.succeed("")),
          ),
      );

      // 4. HONEST CHECK: a demo where NO chapter passed is broken, not green.
      //    Fail the run so the dispatcher posts a `failure` conclusion — the
      //    per-story breakdown is logged above + carried on the error. (A
      //    partial pass still SUCCEEDS so the green check + summary table show
      //    which chapters passed/failed — see the table above.) The full
      //    breakdown is in the io.log line above; AcceptanceFailed is the
      //    same "run's checks failed" error cdp-acceptance uses.
      if (passedCount === 0) {
        return yield* Effect.fail(new AcceptanceFailed({ exitCode: 1 }));
      }

      // The check-run summary the Dispatcher posts EMBEDS `summaryMd` verbatim.
      return {
        replayUri: primary?.replayUri ?? "",
        replayJsonUri: primary?.replayJsonUri ?? "",
        summaryMd,
        stories,
      };
    }),
});
