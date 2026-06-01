// Run-level unit tests for the `pr-review` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network.
//
//   (a) green path    — full-tier diff, coordinate exits 0 with JSON verdict
//                        → ReviewOutput with tier stitched in
//   (b) trivial tier  — risk-tier returns "trivial", only code-quality agent
//                        runs, coordinator uses "sonnet"
//   (c) re-review     — priorExecution returns a previous output; seed-previous
//                        step fires and "--previous" is passed to coordinate
//   (d) determinism   — run body must not call Date.now() / crypto.randomUUID()
//                        / Math.random() directly
//
// Spec: specs/pm/plan.md § PR3, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { prReview } from "./pr-review";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  baseSha: "base456",
  pr: 42,
} as const;

const greenVerdictJson = JSON.stringify({
  verdict: "approve",
  critical: 0,
  warnings: 0,
  suggestions: 1,
  findings: [],
});

describe("pr-review", () => {
  it.effect("green path — full tier, coordinate exits 0, tier stitched in", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "review-agent diff": { exitCode: 0, stdout: "" },
        "review-agent risk-tier": { exitCode: 0, stdout: "full" },
        "review-agent run": { exitCode: 0, stdout: "" },
        "review-agent coordinate": { exitCode: 0, stdout: greenVerdictJson },
      },
    });

    return Effect.gen(function* () {
      const result = yield* prReview.run(baseInput);

      expect(result.tier).toBe("full");
      expect(result.verdict).toBe("approve");
      expect(result.critical).toBe(0);
      expect(result.findings).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("trivial tier — only code-quality agent, model is sonnet", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "review-agent diff": { exitCode: 0, stdout: "" },
        "review-agent risk-tier": { exitCode: 0, stdout: "trivial" },
        "review-agent run": { exitCode: 0, stdout: "" },
        "review-agent coordinate": { exitCode: 0, stdout: greenVerdictJson },
      },
    });

    return Effect.gen(function* () {
      const result = yield* prReview.run(baseInput);

      expect(result.tier).toBe("trivial");
      // Only one agent ran — the review step should have one exec call
      const reviewStep = handles.executions.steps.find((s) => s.name === "review");
      expect(reviewStep).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "re-review — prior findings cross the step boundary as plain data, seed-prior fires, --previous passed to coordinate",
    () => {
      // Seed a previous terminal execution for this PR's family. `load-prior`
      // resolves it to `Option.some(...)`; the run must hand the step boundary
      // PLAIN data (not the Option itself), or CF Workflows' result serializer
      // rejects it at runtime ("Could not serialize object of type Object").
      // The inline runner asserts the same serializability contract, so a
      // regression here fails this test rather than only in production.
      const { layer, handles } = makeCFRuntimeTest({
        io: {
          prior: {
            executionId: "01PREV0000000000000000000",
            sha: "prev789",
            finishedAt: 1_700_000_000_000,
            output: {
              verdict: "comment",
              tier: "full",
              critical: 0,
              warnings: 1,
              suggestions: 0,
              findings: [
                {
                  path: "src/a.ts",
                  startLine: 10,
                  endLine: 12,
                  level: "warning",
                  title: "prior finding",
                  message: "still open?",
                },
              ],
            },
          },
        },
        sandboxProgram: {
          "review-agent diff": { exitCode: 0, stdout: "" },
          "review-agent risk-tier": { exitCode: 0, stdout: "full" },
          "review-agent run": { exitCode: 0, stdout: "" },
          "review-agent seed-previous": { exitCode: 0, stdout: "" },
          "review-agent coordinate": { exitCode: 0, stdout: greenVerdictJson },
        },
      });

      return Effect.gen(function* () {
        const result = yield* prReview.run(baseInput);
        expect(result.verdict).toBe("approve");

        // The Some path executed: the seed-prior step ran...
        const seedStep = handles.executions.steps.find(
          (s) => s.name === "seed-prior",
        );
        expect(seedStep).toBeDefined();

        // ...and the coordinator was told to reconcile against the prior set.
        const coordinate = handles.sandbox.execs.find((e) =>
          e.command.includes("review-agent coordinate"),
        );
        expect(coordinate?.command).toContain("--previous");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("determinism guard — no Date.now / randomUUID / Math.random in run source", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./pr-review.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/\bDate\.now\(\)/);
    expect(src).not.toMatch(/\bcrypto\.randomUUID\(\)/);
    expect(src).not.toMatch(/\bMath\.random\(\)/);
    return Effect.void;
  });
});
