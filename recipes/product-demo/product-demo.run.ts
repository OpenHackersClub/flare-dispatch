// Recipe: AI-driven product demo — the `product-demo` Run
//
// The typed Run that ./ci.yml dispatches. A team hands it a deployed URL
// (preview / staging / prod) and a list of user stories as prose; the run
// records ONE master video while driving the site through each story in
// sequence, captures key screenshots, writes a per-story narrative, and then
// produces a holistic markdown summary across all stories that a reviewer
// can paste into the PR.
//
// No checkout — the target is a deployed URL, not the repo. The run only
// attaches to Browser Rendering over CDP and shells out to the bundled
// `demo-agent` CLI (baked into the `flare-dispatch-demo:latest` image, the
// same shape as `review-agent` in recipes/ai-code-review). The agent owns
// recording mechanics, model calls, and story playback; this run only
// orchestrates: attach → record start → for each story play → record stop →
// upload → summarize.
//
// Mode: Action — dispatched by ./ci.yml on `pull_request` and on manual
//       `workflow_dispatch`. See specs/04-gha-integration.md § Action mode.
// DSL:  uses `browser.newCDPSession`, `sandbox.exec`, `artifact.upload`,
//       `config.get`, and `io.priorExecution` — specs/03-dsl.md § Capabilities.

import { Effect, Schema, Option } from "effect";
import {
  defineRun,
  step,
  sandbox,
  browser,
  artifact,
  config,
  io,
} from "@flare-dispatch/core";

// A user story is just a name + prose. The agent reads the prose, decides
// the next browser action, applies it over the live CDP session, captures
// screenshots, and emits a narrative. Names must be unique within the
// `stories` array — they become chapter markers on the master video.
const Story = Schema.Struct({
  name: Schema.String,
  prose: Schema.String,
});

const Input = Schema.Struct({
  // The deployed URL the demo runs against. No checkout — this is the
  // target site, not the repo. `repo` and `sha` are still required because
  // the check-run callback anchors to them (specs/04-gha-integration.md
  // § Check-runs callback).
  repo: Schema.String,
  sha: Schema.String,
  deployedUrl: Schema.String,
  stories: Schema.Array(Story),
  // The viewport preset is passed through to the agent — it sets the CDP
  // viewport once at attach time so the master video uses one resolution.
  // Default desktop; "mobile" emulates a phone profile in the agent.
  viewportPreset: Schema.optional(Schema.Literal("desktop", "mobile")),
  // Per-story wall-clock ceiling. Stories run sequentially so the master
  // video stays one continuous track; without a per-story cap one stuck
  // story would burn the whole run's `maxDurationSec`.
  maxDurationSecPerStory: Schema.optional(Schema.Number),
});

// Each story round-trips its own per-chapter record so the summary can
// point a reviewer at the exact span of the master video to look at.
const StoryResult = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("passed", "failed"),
  durationMs: Schema.Number,
  // The video has one continuous timeline; these are offsets into it, in
  // ms, so a reviewer can jump straight to a story's chapter.
  videoStartMs: Schema.Number,
  videoEndMs: Schema.Number,
  narrative: Schema.String,
  keyScreenshotUri: Schema.String,
});

const Output = Schema.Struct({
  videoUri: Schema.String,        // signed R2 URL — embeddable in the PR
  summaryMd: Schema.String,       // the holistic LLM-written summary
  stories: Schema.Array(StoryResult),
});

export const productDemo = defineRun({
  name: "product-demo",
  version: "1.0.0",
  // `demo-agent` lives in this image — recording mechanics, the model
  // client, and the CDP-driver glue. See README.md § The demo agent.
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-demo:latest",
  inputs: Input,
  outputs: Output,
  // Stories run SEQUENTIALLY against one CDP session so the master video is
  // one continuous file with chapter markers. `maxConcurrency: 1` makes the
  // sequencing explicit and keeps the Browser Rendering session count to 1.
  // `requiresBrowser: true` reserves a slot in the Browser Rendering pool.
  limits: { maxDurationSec: 3600, maxConcurrency: 1, requiresBrowser: true },

  run: (input) =>
    Effect.gen(function* () {
      const viewport = input.viewportPreset ?? "desktop";
      const perStorySec = input.maxDurationSecPerStory ?? 180;

      // 1. Attach Browser Rendering over CDP against the DEPLOYED URL. No
      //    checkout, no app boot — the site is already live. The CDP
      //    endpoint flows to the agent; the agent applies the viewport
      //    profile and drives the page.
      const session = yield* step("attach-cdp", () =>
        browser.newCDPSession({ targetUrl: input.deployedUrl }),
      );

      // Filesystem layout inside the container — relative paths the agent
      // and the artifact uploads share. The container's working dir is its
      // own; the agent writes here.
      const videoPath = "/tmp/demo/master.webm";
      const screenshotsDir = "/tmp/demo/screenshots";
      const storiesJsonPath = "/tmp/demo/stories.json";
      const summaryPath = "/tmp/demo/summary.md";

      // 2. Tell the agent to start recording. The agent owns the recording
      //    pipeline (one chromium tab → ffmpeg → master.webm); the run only
      //    sees a path. `record start` returns once recording is live so
      //    the first story's first frame is captured.
      yield* step("record-start", () =>
        sandbox.exec({
          command: [
            "demo-agent", "record", "start",
            "--cdp-ws", session.wsEndpoint,
            "--viewport", viewport,
            "--out", videoPath,
          ],
        }),
      );

      // 3. Walk the stories in order. Each `demo-agent play` reads the
      //    prose, applies actions over the SAME CDP session (so the video
      //    timeline stays continuous), captures key screenshots into
      //    `screenshotsDir`, and emits one JSON line per story with the
      //    chapter offsets, status, narrative, and the key-screenshot path.
      //    Concurrency 1 — see `limits` above.
      const playResults = yield* step("play-stories", () =>
        Effect.forEach(
          input.stories,
          (story) =>
            sandbox.exec({
              command: [
                "demo-agent", "play",
                "--cdp-ws", session.wsEndpoint,
                "--name", story.name,
                "--prose", story.prose,
                "--screenshots", screenshotsDir,
                "--max-sec", String(perStorySec),
              ],
              timeoutSec: perStorySec + 30,
            }),
          { concurrency: 1 },
        ),
      );

      // 4. Stop recording. The agent flushes the video file and exits.
      yield* step("record-stop", () =>
        sandbox.exec({
          command: ["demo-agent", "record", "stop", "--out", videoPath],
        }),
      );

      // 5. Parse each `play` step's JSON stdout. The agent's contract: one
      //    JSON object per invocation on the LAST line of stdout (anything
      //    before is logs). The shape is fixed by the agent — mirrors the
      //    `review-agent coordinate --json` pattern in recipes/ai-code-review.
      type PlayJson = {
        status: "passed" | "failed";
        durationMs: number;
        videoStartMs: number;
        videoEndMs: number;
        narrative: string;
        keyScreenshotPath: string;
      };
      const parsed = playResults.map((r, i) => {
        const lastLine = r.stdout.trim().split("\n").pop() ?? "{}";
        return {
          story: input.stories[i],
          json: JSON.parse(lastLine) as PlayJson,
        };
      });

      // 6. Upload the master video once, signed for 30 days so the link
      //    survives PR-review cycles. Reviewers paste the URL straight into
      //    the PR description.
      const videoUri = yield* step("upload-video", () =>
        artifact.upload({
          name: "demo-video.webm",
          path: videoPath,
          contentType: "video/webm",
          signedUrlTTL: "30 days",
        }),
      );

      // 7. Upload each story's key screenshot in parallel (concurrency 4
      //    — independent uploads, no shared state). Each returns its own
      //    signed URL embedded into the per-story result.
      const screenshotUris = yield* step("upload-screenshots", () =>
        Effect.forEach(
          parsed,
          (p) =>
            artifact.upload({
              name: `${p.story.name}.png`,
              path: p.json.keyScreenshotPath,
              contentType: "image/png",
              signedUrlTTL: "30 days",
            }),
          { concurrency: 4 },
        ),
      );

      // 8. Resolve the summary model through the control plane. Mirrors the
      //    `pr-review` pattern (recipes/ai-code-review) — an operator can
      //    repoint `product-demo.model.summary` in KV without redeploying
      //    when a provider degrades. Default `opus`; never a hard failure
      //    (config is `tuning`, not `gating` — see specs/03-dsl.md § config).
      const summaryModel = yield* step("resolve-model", () =>
        config.get("product-demo.model.summary").pipe(
          Effect.map((override) => override ?? "opus"),
        ),
      );

      // 9. Stitch typed per-story results, then write them to disk for the
      //    agent's summarizer. Doing the file write through `sandbox.exec`
      //    keeps everything inside the container — the agent and the file
      //    sit on the same filesystem.
      const stories = parsed.map((p, i) => ({
        name: p.story.name,
        status: p.json.status,
        durationMs: p.json.durationMs,
        videoStartMs: p.json.videoStartMs,
        videoEndMs: p.json.videoEndMs,
        narrative: p.json.narrative,
        keyScreenshotUri: screenshotUris[i],
      }));
      yield* step("write-stories-json", () =>
        sandbox.exec({
          command: [
            "demo-agent", "write-json",
            "--out", storiesJsonPath,
            "--data", JSON.stringify({ stories, videoUri }),
          ],
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
            }).pipe(Effect.as(["--previous", "/tmp/demo/previous.md"] as const)),
          ),
      });

      // 12. Generate the holistic summary. The agent emits the markdown to
      //     stdout AND writes it to `--out`; we read it from stdout because
      //     `io` has no file-read primitive — see specs/03-dsl.md § io.
      const summaryResult = yield* step("summarize", () =>
        sandbox.exec({
          command: [
            "demo-agent", "summarize",
            "--stories-json", storiesJsonPath,
            "--model", summaryModel,
            "--out", summaryPath,
            ...previousArgs,
          ],
        }),
      );

      yield* io.log(
        "info",
        `product-demo: ${stories.length} stories, ${stories.filter((s) => s.status === "passed").length} passed`,
      );

      // The check-run summary the Dispatcher posts EMBEDS `summaryMd`
      // verbatim and links `videoUri` — reviewers see the holistic write-up
      // on the PR's Checks tab and one signed video link they can drop
      // straight into the PR description (see specs/04-gha-integration.md
      // § Inline findings — summary).
      return {
        videoUri,
        summaryMd: summaryResult.stdout.trim(),
        stories,
      };
    }),
});
