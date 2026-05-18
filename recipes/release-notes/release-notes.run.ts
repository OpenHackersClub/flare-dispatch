// Recipe: weekly release notes with a human gate
//
// A Schedule-mode run that drafts release notes every Monday, posts the draft
// for review, and hibernates on a human approval before publishing the
// GitHub Release. It pairs the two things Schedule mode is for: a wall-clock
// trigger (a Cloudflare Cron Trigger, not a GitHub event) and a durable
// pause (step.waitForEvent — the Workflow sleeps for up to 72h at no CPU
// cost, surviving Worker eviction, until someone clicks approve).
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode.
// DSL:  `schedules` on defineRun; `step.waitForEvent` for the human gate
//       (specs/03-dsl.md § Human-in-the-loop); `workspace` to check out the
//       repo; `artifact` for the rendered draft; `io.env` to read the
//       publish token from a Worker Secret.
//
// The draft itself is built from `git log` since the last tag by a
// `release-notes` CLI baked into the image — all GitHub/LLM specifics live
// in that CLI, exactly as `review-agent` does for ai-code-review. The run
// only orchestrates: draft, post, wait, publish.

import { Effect, Match, Schema, Option } from "effect";
import { defineRun, step, sandbox, artifact, io } from "@flare-dispatch/core";
import { workspace } from "@flare-dispatch/core/primitives";

// The repo this run cuts releases for. One scheduled run per release line.
const TARGET = { repo: "openhackersclub/flare-dispatch", ref: "main" } as const;

// ISO year + week (e.g. "2026-W21") — the cron-window dedup key, so re-firing
// the same week is a no-op (04-gha-integration § Receiver dedup).
const isoYearWeek = (ms: number): string => {
  const d = new Date(ms);
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((thu.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

// The inbound approval signal — POSTed to /v1/admin/events/:wf_id behind CF
// Access (specs/03-dsl.md § Human-in-the-loop).
const ApprovalPayload = Schema.Struct({
  decision: Schema.Literal("approve", "reject"),
  deciderEmail: Schema.String,
});

const Input = Schema.Struct({
  since: Schema.Number, // epoch ms — include changes merged after this
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  published: Schema.Boolean,
  reason: Schema.Literal("published", "rejected", "no-changes"),
  tag: Schema.String,
  notesUri: Schema.String, // signed R2 URL to the rendered draft
});

export const releaseNotes = defineRun({
  name: "release-notes",
  version: "1.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-release:latest",

  // Schedule mode: 09:00 UTC every Monday. Must also appear in
  // wrangler.jsonc `triggers.crons` (specs/05-byoc.md § Wrangler config).
  schedules: [
    {
      cron: "0 9 * * 1",
      idempotencyKey: ({ firedAt }) => `release-notes:${isoYearWeek(firedAt)}`,
      // A cron tick names no target; the coarse scope is just the window.
      inputs: ({ firedAt }) => ({
        since: firedAt - 7 * 86_400_000,
        firedAt,
      }),
    },
  ],

  inputs: Input,
  outputs: Output,

  // Wall-clock ceiling covers the 72h approval wait — the Workflow hibernates
  // for almost all of it, consuming no CPU.
  limits: { maxDurationSec: 4 * 24 * 3600 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Check out the release repo. The `release-notes` CLI is baked into
      //    the image, so no dependency install — just container + clone.
      const { container, dir } = yield* workspace({
        repo: TARGET.repo,
        sha: TARGET.ref,
      });

      // 2. Draft the notes from `git log <last-tag>..HEAD`. The CLI emits a
      //    markdown file and prints a one-line JSON summary { tag, changes }.
      const NOTES = "/tmp/release-notes.md";
      const draft = yield* step("draft-notes", () =>
        sandbox
          .exec({
            cwd: dir,
            container,
            command: [
              "release-notes", "draft",
              "--since", new Date(input.since).toISOString(),
              "--out", NOTES,
            ],
          })
          .pipe(
            Effect.map(
              (r) => JSON.parse(r.stdout) as { tag: string; changes: number },
            ),
          ),
      );

      // 3. Nothing merged this week — skip the release and the human gate.
      if (draft.changes === 0) {
        return {
          published: false as const,
          reason: "no-changes" as const,
          tag: draft.tag,
          notesUri: "",
        };
      }

      // 4. Upload the rendered draft so reviewers (and the check-run summary)
      //    have a stable link to read before deciding.
      const notesUri = yield* step("upload-draft", () =>
        artifact.upload({
          name: "release-notes.md",
          path: NOTES,
          container,
          contentType: "text/markdown",
          signedUrlTTL: "30 days",
        }),
      );

      yield* step("notify", () =>
        io.log("info", `release ${draft.tag} drafted — awaiting approval`, {
          notesUri,
          changes: draft.changes,
        }),
      );

      // 5. Hibernate until a human approves. The Workflow consumes no CPU and
      //    survives eviction for the full timeout window.
      const approval = yield* step.waitForEvent("release approval", {
        type: "release-approval",
        timeout: "72 hours",
        payloadSchema: ApprovalPayload,
      });

      // 6. Exhaustive match on the decision — a new variant becomes a compile
      //    error, never a silent fall-through.
      return yield* Match.value(approval.decision).pipe(
        Match.when("reject", () =>
          Effect.succeed({
            published: false as const,
            reason: "rejected" as const,
            tag: draft.tag,
            notesUri,
          }),
        ),
        Match.when("approve", () =>
          Effect.gen(function* () {
            // Publishing is a GitHub *write*, which the read-only `github`
            // capability does not do — so it shells out to `gh` inside the
            // container. The token is a fine-grained PAT the operator sets as
            // the Worker Secret RELEASE_PUBLISH_TOKEN; `io.env` reads it (and
            // keeps the read deterministic across checkpoint replay).
            const token = yield* step("read-token", () =>
              io.env("RELEASE_PUBLISH_TOKEN"),
            );
            yield* step("publish-release", () =>
              Option.match(Option.fromNullable(token), {
                onNone: () =>
                  Effect.fail(
                    new Error("RELEASE_PUBLISH_TOKEN secret is not set"),
                  ),
                onSome: (tok) =>
                  sandbox.exec({
                    cwd: dir,
                    container,
                    env: { GH_TOKEN: tok },
                    command: [
                      "release-notes", "publish",
                      "--tag", draft.tag,
                      "--notes-file", NOTES,
                    ],
                  }),
              }),
            );
            return {
              published: true as const,
              reason: "published" as const,
              tag: draft.tag,
              notesUri,
            };
          }),
        ),
        Match.exhaustive,
      );
    }),
});
