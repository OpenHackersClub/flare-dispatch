// Run-level unit tests for the `pr-review` run (v3 — Worker-side engine).
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network, no model provider.
//
// The `review` step calls the model (the `coordinate` step is pure code), so
// the *model path* is covered exhaustively in the engine's own unit tests
// (packages/review-agent/src/engine.test.ts) with a stub `HttpClient`. These
// run-level tests cover the ORCHESTRATION that needs no model:
//
//   (a) diff via git    — `prepare-diff` shells out to `git diff --output=<file>`
//                          (not a `review-agent` CLI), reads the FULL diff back
//                          via `sandbox.readFile` (never the 16KB-tail
//                          `ExecResult.stdout`), and a non-zero git exit FAILS
//                          the step (honest red check).
//   (b) always-comment  — on ANY failure the run still posts a PR review
//                          comment (the operator must always get a comment),
//                          via the `github.pullReview` write capability.
//   (c) misconfig        — an unconfigured backend fails with a comment naming
//                          the missing config key.
//   (d) determinism      — no Date.now() / crypto.randomUUID() / Math.random()
//                          in the run source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { prReview } from "./pr-review";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  baseSha: "base456",
  pr: 42,
  installationId: 7,
} as const;

/** Where the run writes + reads the diff inside the container. */
const DIFF_FILE = "/tmp/pr-review.diff";

/** Backend config so the run survives `resolve-backend` (now the first step). */
const backendConfig = {
  "pr-review.opencode.model": "@cf/test/model",
} as const;

/** A scripted `report` tool call answering every domain reviewer with no findings. */
const emptyReport = {
  toolCalls: [{ name: "report", arguments: { findings: [] } }],
  text: "",
} as const;

describe("pr-review", () => {
  it.effect(
    "prepare-diff shells out to `git diff --output=<file>`, not a review-agent CLI",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: {
          "git diff": { exitCode: 0, stdout: "" },
        },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        const diffExec = handles.sandbox.execs.find((e) =>
          e.command.startsWith("git diff"),
        );
        expect(diffExec).toBeDefined();
        expect(diffExec?.command).toContain(baseInput.baseSha);
        expect(diffExec?.command).toContain(baseInput.sha);
        expect(diffExec?.command).toContain(`--output=${DIFF_FILE}`);
        // The diff is read back in full from the file.
        expect(handles.sandbox.reads).toContainEqual({ path: DIFF_FILE });
        // The old `review-agent` CLI is gone entirely.
        const reviewAgent = handles.sandbox.execs.find((e) =>
          e.command.includes("review-agent"),
        );
        expect(reviewAgent).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the reviewers see the FULL file diff, not the 16KB ExecResult.stdout tail",
    () => {
      // A diff large enough that an stdout-tail read would (a) under-count the
      // risk tier and (b) hide the leading sections from the model. The exec's
      // stdout is a decoy tail — only the file carries the real diff.
      const marker = "+const LEADING_SECTION_ONLY_IN_THE_FILE = true;";
      const bigDiff = [
        "diff --git a/lead.ts b/lead.ts",
        "+++ b/lead.ts",
        marker,
        ...Array.from({ length: 300 }, (_, i) => `+const pad${i} = ${i};`),
      ].join("\n");

      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: {
          "git diff": { exitCode: 0, stdout: "(decoy tail — must not be used)" },
        },
        sandboxFiles: { [DIFF_FILE]: bigDiff },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        // Every domain reviewer's user message embeds the file's diff,
        // including its LEADING section — proof the read wasn't a tail.
        expect(handles.modelGateway.requests.length).toBeGreaterThan(0);
        for (const req of handles.modelGateway.requests) {
          expect(req.user).toContain(marker);
          expect(req.user).not.toContain("decoy tail");
        }
        // >200 changed lines → the size heuristic escalated past "trivial"/"lite".
        const fullAgents = ["release-management", "compliance", "agents-md"];
        const comment = handles.github.pullReviewCalls[0]!.body;
        for (const agent of fullAgents) expect(comment).toContain(agent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a non-zero git diff exit FAILS the run (honest red check)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      // Backend configured so the run reaches `prepare-diff` (resolve-backend
      // now runs first, fail-fast before paying for a container).
      config: backendConfig,
      sandboxProgram: {
        // git diff exits non-zero — a real failure, not swallowed.
        "git diff": { exitCode: 128, stdout: "", stderr: "fatal: bad object" },
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(prReview.run(baseInput));
      expect(Exit.isFailure(exit)).toBe(true);

      // The run still posted a PR comment explaining the failure.
      expect(handles.github.pullReviewCalls).toHaveLength(1);
      const comment = handles.github.pullReviewCalls[0]!;
      expect(comment.repo).toBe(baseInput.repo);
      expect(comment.pr).toBe(baseInput.pr);
      expect(comment.body).toContain("could not complete");
      expect(comment.body).toContain("<!-- flare-dispatch: pr-review -->");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "an unconfigured backend fails with a comment naming the missing key",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        // No `pr-review.*` config keys seeded → resolveBackend fails.
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(prReview.run(baseInput));
        expect(Exit.isFailure(exit)).toBe(true);

        expect(handles.github.pullReviewCalls).toHaveLength(1);
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain("misconfigured");
        expect(body).toContain("pr-review.opencode.model");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the PR comment is anchored to the head sha and carries the installation id",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const comment = handles.github.pullReviewCalls[0]!;
        expect(comment.sha).toBe(baseInput.sha);
        expect(comment.installationId).toBe(baseInput.installationId);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "determinism guard — no Date.now / randomUUID / Math.random in run source",
    () => {
      const src = readFileSync(
        fileURLToPath(new URL("./pr-review.ts", import.meta.url)),
        "utf8",
      );
      expect(src).not.toMatch(/\bDate\.now\(\)/);
      expect(src).not.toMatch(/\bcrypto\.randomUUID\(\)/);
      expect(src).not.toMatch(/\bMath\.random\(\)/);
      return Effect.void;
    },
  );
});
