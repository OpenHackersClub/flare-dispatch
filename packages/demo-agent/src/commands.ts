// @flare-dispatch/demo-agent — @effect/cli subcommand definitions.
//
// Six subcommands the `product-demo` run shells out to:
//   record start | record stop | play | summarize | write-json | write-prior
//
// Each subcommand:
//   * decodes options via `@effect/cli`,
//   * runs the platform logic (attachCdp, runPlayLoop, fetchRecording,
//     summarizeStories, fs.writeFile),
//   * emits its JSON contract on stdout (`record stop`, `play`) or its
//     markdown payload (`summarize`),
//   * maps every tagged error to a one-line stderr message + non-zero exit.

import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { Console, Effect, Layer, Match } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { attachCdp, applyViewport } from "./cdp.js";
import { ViewportPreset } from "./schemas.js";
import {
  configFromEnv as recordingConfigFromEnv,
  fetchRecording,
} from "./recorder.js";
import { runPlayLoop } from "./play.js";
import { makeLanguageModelLayer, summarizeStories } from "./model.js";
import {
  type AgentError,
  CdpAttachFailed,
  CdpCommandFailed,
  FsFailed,
  MissingEnv,
  ModelCallFailed,
  RecordingFetchFailed,
  StoryTimeout,
} from "./errors.js";
import { StoriesJson } from "./schemas.js";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Option declarations — shared across subcommands.

const cdpWsOption = Options.text("cdp-ws").pipe(
  Options.withDescription(
    "Browser Rendering CDP WebSocket endpoint (wss://...?recording=true)",
  ),
);
const outOption = Options.text("out").pipe(
  Options.withDescription("Output file path."),
);
const sessionIdOutOption = Options.text("session-id-out").pipe(
  Options.withDescription("Where to write the captured Browser Rendering session id."),
);
const sessionIdInOption = Options.text("session-id-in").pipe(
  Options.withDescription("File written by `record start` with the session id."),
);
const viewportOption = Options.choice("viewport", ["desktop", "mobile"]).pipe(
  Options.withDescription("Viewport preset — passed to Emulation.setDeviceMetricsOverride."),
  Options.withDefault("desktop" as const),
);
const dataOption = Options.text("data").pipe(
  Options.withDescription("Inline payload (JSON for write-json, markdown for write-prior)."),
);
const nameOption = Options.text("name").pipe(
  Options.withDescription("Story name — becomes the chapter marker."),
);
const proseOption = Options.text("prose").pipe(
  Options.withDescription("Story prose the model walks through."),
);
const screenshotsOption = Options.text("screenshots").pipe(
  Options.withDescription("Directory for per-story screenshots."),
);
const maxSecOption = Options.integer("max-sec").pipe(
  Options.withDescription("Per-story wall-clock ceiling in seconds."),
);
const storiesJsonOption = Options.text("stories-json").pipe(
  Options.withDescription("Path to the stories.json the summarizer reads."),
);
const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Provider model id (e.g. `gpt-4o`, `claude-opus-4-7`, `@cf/meta/llama-3.1-70b-instruct`). The string passes through to the configured `LanguageModel` layer verbatim.",
  ),
);
const previousOption = Options.text("previous").pipe(
  Options.optional,
  Options.withDescription("Optional: path to previous run's summary markdown."),
);

// ---------------------------------------------------------------------------
// `record start`

const recordStart = Command.make(
  "start",
  {
    cdpWs: cdpWsOption,
    viewport: viewportOption,
    sessionIdOut: sessionIdOutOption,
  },
  ({ cdpWs, viewport, sessionIdOut }) =>
    Effect.gen(function* () {
      const { session, page } = yield* attachCdp(cdpWs);
      yield* applyViewport(page, viewport as ViewportPreset);
      const sessionId = yield* session.sessionId();
      yield* writeFile(sessionIdOut, sessionId);
      // `record start` does NOT disconnect — the WebSocket would close
      // server-side and finalize the recording prematurely. The platform
      // closes the session when `record stop` calls `Browser.close`. The
      // attach in `record start` is short-lived: we connect, set viewport,
      // get the session id, write it, and disconnect cleanly without
      // requesting Browser.close.
      yield* session.close();
      yield* Console.log(`session-id written to ${sessionIdOut}`);
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `record stop`

const recordStop = Command.make(
  "stop",
  {
    cdpWs: cdpWsOption,
    sessionIdIn: sessionIdInOption,
    out: outOption,
  },
  ({ cdpWs: _cdpWs, sessionIdIn, out }) =>
    Effect.gen(function* () {
      // The agent's role here is NOT to close the browser — `attachCdp` opens
      // a *fresh* connection from this short-lived CLI invocation; closing
      // it would not affect the underlying Browser Rendering session that
      // the play loop already finished using. Browser Rendering finalizes
      // the recording on its own session-idle timer once the play step
      // returns. We just need to fetch.
      const sessionId = yield* readFile(sessionIdIn).pipe(
        Effect.map((s) => s.trim()),
      );
      const cfg = yield* recordingConfigFromEnv(process.env);
      const events = yield* fetchRecording(sessionId, cfg);
      yield* writeFile(out, JSON.stringify(events));
      // Final-line JSON per the run's contract.
      yield* Console.log(
        JSON.stringify({ sessionId, eventCount: events.length }),
      );
    }).pipe(Effect.catchAll(reportAndDie)),
);

export const recordCommand = Command.make("record", {}).pipe(
  Command.withSubcommands([recordStart, recordStop]),
);

// ---------------------------------------------------------------------------
// `play`

const playCommand = Command.make(
  "play",
  {
    cdpWs: cdpWsOption,
    name: nameOption,
    prose: proseOption,
    screenshots: screenshotsOption,
    maxSec: maxSecOption,
    model: modelOption,
  },
  ({ cdpWs, name, prose, screenshots, maxSec, model }) =>
    Effect.gen(function* () {
      const attachedAtMs = Date.now();
      const attached = yield* attachCdp(cdpWs);
      const result = yield* runPlayLoop(
        {
          name,
          prose,
          screenshotsDir: screenshots,
          maxSec,
          attachedAtMs,
        },
        { session: attached.session },
      ).pipe(Effect.provide(makeLanguageModelLayer(model)));
      yield* attached.session.close();
      yield* Console.log(JSON.stringify(result));
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `summarize`

const summarizeCommand = Command.make(
  "summarize",
  {
    storiesJson: storiesJsonOption,
    model: modelOption,
    out: outOption,
    previous: previousOption,
  },
  ({ storiesJson, model, out, previous }) =>
    Effect.gen(function* () {
      const raw = yield* readFile(storiesJson);
      const parsed: unknown = JSON.parse(raw);
      const decode = Schema.decodeUnknownEither(StoriesJson);
      const decoded = decode(parsed);
      if (decoded._tag === "Left") {
        yield* Console.error(
          `error: --stories-json malformed: ${decoded.left.message}`,
        );
        return yield* Effect.die("StoriesJson decode failed");
      }
      const previousMd =
        previous._tag === "Some"
          ? yield* readFile(previous.value).pipe(
              Effect.catchTag("FsFailed", () => Effect.succeed("")),
            )
          : "";
      const md = yield* summarizeStories({
        stories: decoded.right.stories,
        replayUri: decoded.right.replayUri,
        replayJsonUri: decoded.right.replayJsonUri,
        previous: previousMd,
      }).pipe(Effect.provide(makeLanguageModelLayer(model)));
      yield* writeFile(out, md);
      yield* Console.log(md);
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `write-json` / `write-prior`

const writeJsonCommand = Command.make(
  "write-json",
  { out: outOption, data: dataOption },
  ({ out, data }) =>
    Effect.gen(function* () {
      // Validate JSON before writing — a malformed --data is a config bug
      // we'd rather fail loudly than persist.
      try {
        JSON.parse(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        yield* Console.error(`error: --data is not valid JSON: ${msg}`);
        return yield* Effect.die("invalid --data");
      }
      yield* writeFile(out, data);
    }).pipe(Effect.catchAll(reportAndDie)),
);

const writePriorCommand = Command.make(
  "write-prior",
  { out: outOption, data: dataOption },
  ({ out, data }) =>
    writeFile(out, data).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// Top-level export consumed by main.ts. `@effect/cli`'s `withSubcommands`
// expects a non-empty readonly tuple, so we spell the tuple out rather than
// going through `Array<Command>`.

export const subcommands = [
  recordCommand,
  playCommand,
  summarizeCommand,
  writeJsonCommand,
  writePriorCommand,
] as const;

// ---------------------------------------------------------------------------
// Helpers.

const writeFile = (
  filePath: string,
  body: string,
): Effect.Effect<void, FsFailed> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined),
      catch: (e) =>
        new FsFailed({
          path: path.dirname(filePath),
          op: "mkdir",
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    yield* Effect.tryPromise({
      try: () => fs.writeFile(filePath, body, "utf8"),
      catch: (e) =>
        new FsFailed({
          path: filePath,
          op: "write",
          message: e instanceof Error ? e.message : String(e),
        }),
    });
  });

const readFile = (filePath: string): Effect.Effect<string, FsFailed> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (e) =>
      new FsFailed({
        path: filePath,
        op: "read",
        message: e instanceof Error ? e.message : String(e),
      }),
  });

const reportAndDie = (e: AgentError): Effect.Effect<never, never, never> =>
  Match.value(e).pipe(
    Match.tag("CdpAttachFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: CDP attach failed (${err.reason}): ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("CdpCommandFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: CDP ${err.method} failed: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("RecordingFetchFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: recording fetch failed (${err.reason}) for session ${err.sessionId}: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("ModelCallFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: model ${err.model} failed (${err.reason}): ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("MissingEnv", (err) =>
      Effect.gen(function* () {
        yield* Console.error(`error: required env var not set: ${err.name}`);
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("FsFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: fs ${err.op} ${err.path}: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("StoryTimeout", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: story ${err.name} timed out after ${err.maxSec}s (${err.actionsApplied} actions applied)`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.exhaustive,
  );

// Silence unused-import warnings — these symbols are exported only for tests
// importing the error types alongside the commands.
export type _UnusedErrorRefs =
  | CdpAttachFailed
  | CdpCommandFailed
  | RecordingFetchFailed
  | ModelCallFailed
  | MissingEnv
  | FsFailed
  | StoryTimeout;
