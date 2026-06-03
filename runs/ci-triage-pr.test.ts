// Run-level unit tests for `ci-triage-pr` — drive the run against the in-memory
// test runtime with seeded config + github (actionRuns) + cloudflare
// (deployments) + model fakes.

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import type {
  DeploymentRef,
  ModelCompletionResult,
  WorkflowRunRef,
} from "@flare-dispatch/core";
import { ciTriagePr } from "./ci-triage-pr";

const firedAt = Date.UTC(2026, 5, 3); // 2026-06-03
const input = { firedAt } as const;

const failedRun: WorkflowRunRef = {
  repo: "owner/name",
  id: 1,
  name: "CI/CD",
  headBranch: "main",
  headSha: "deadbeef",
  status: "completed",
  conclusion: "failure",
  url: "https://github.com/owner/name/actions/runs/1",
  createdAt: firedAt - 3_600_000, // 1h before fire → within a 24h window
};

const failedDeploy: DeploymentRef = {
  project: "site",
  id: "dep1",
  environment: "production",
  status: "failure",
  url: "https://site.pages.dev",
  branch: "main",
  createdAt: firedAt - 3_600_000,
};

const triage = (): ModelCompletionResult => ({
  toolCalls: [
    {
      name: "report_triage",
      arguments: {
        summary: "2 failures today",
        items: [
          {
            title: "flaky CI",
            area: "github-actions",
            diagnosis: "timeout",
            suggestedFix: "bump timeout",
          },
        ],
      },
    },
  ],
  text: "",
});

const config = {
  "ci-triage.repos": "owner/name",
  "ci-triage.projects": "site",
  "ci-triage.opencode.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

describe("ci-triage-pr", () => {
  it.effect("triages failures and opens a draft PR with the report file", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // The github / cloudflare fakes carry the clock `createdWithinHours`
      // filters against — seed it so the seeded failures stay in-window.
      github: { workflowRuns: [failedRun], now: firedAt },
      cloudflare: { deployments: [failedDeploy], now: firedAt },
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.actionsFailures).toBe(1);
      expect(out.deployFailures).toBe(1);
      expect(out.prOpened).toBe(true);

      const calls = handles.github.openDraftPullRequestCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repo).toBe("owner/name");
      expect(calls[0]!.headBranch).toBe("flare-dispatch/ci-triage-2026-06-03");
      expect(calls[0]!.files[0]!.path).toBe(".flare-dispatch/ci-triage-2026-06-03.md");
      expect(calls[0]!.files[0]!.content).toContain("flaky CI");
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens NO PR when there are no failures in the window", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config,
      // No seeded failures.
      modelGateway: { responses: [triage()] },
    });

    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.actionsFailures).toBe(0);
      expect(out.deployFailures).toBe(0);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
      // Cheap, model not even consulted on a green day.
      expect(handles.modelGateway.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is a no-op when neither repos nor projects are configured", () => {
    const { layer, handles } = makeCFRuntimeTest({ config: {} });
    return Effect.gen(function* () {
      const out = yield* ciTriagePr.run(input);
      expect(out.prOpened).toBe(false);
      expect(handles.github.openDraftPullRequestCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
