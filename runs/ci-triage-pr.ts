// Run: scheduled CI-failure triage → draft PR
//
// A Schedule-mode run that, every day, reads recent CI failures across GitHub
// Actions AND Cloudflare (Pages) deployments, asks a model to triage them, and
// opens ONE draft pull request carrying a triage write-up
// (`.flare-dispatch/ci-triage-<date>.md`) — a diagnosis + suggested next steps a
// human reviews. It does not attempt an auto-fix (that is a larger, lower-
// confidence problem); the value is a single daily, deduped, model-written
// triage of what's red, filed where the team will see it.
//
// --- Reuse: the SAME review infra as ai-code-review --------------------------
//
// The triage model call goes through `@flare-dispatch/review-agent`'s reusable
// `completeStructured` engine — the `opencode` / `reasonix` backend machinery
// `pr-review` uses, resolved from CONFIG_KV under this run's `ci-triage.*`
// namespace. No model API key (the Workers AI binding is the auth). Reading the
// failures uses the `github.actionRuns` + `cloudflare.deployments` read
// capabilities; opening the PR uses `github.openDraftPullRequest`. No container.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  ci-triage.repos          comma/space-separated `owner/name` list to scan Actions on (required)
//   CONFIG_KV  ci-triage.projects       (optional) Cloudflare Pages project names to scan deploys on
//   CONFIG_KV  ci-triage.report-repo    repo to open the triage PR on (default: first of ci-triage.repos)
//   CONFIG_KV  ci-triage.base           base branch for the triage PR (default "main")
//   CONFIG_KV  ci-triage.window-hours   only failures newer than this (default 24)
//   CONFIG_KV  ci-triage.backend        "opencode" | "reasonix"  (default opencode)
//   CONFIG_KV  ci-triage.prompt         (optional) override the triage system prompt
//   CONFIG_KV  ci-triage.opencode.model bare Workers AI model id   (+ .opencode.mode)
//   CONFIG_KV  ci-triage.reasonix.model bare Workers AI model id   (+ .reasonix.mode)
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode. The cron
// MUST also be in wrangler.jsonc `triggers.crons`.

import { Effect, Schema } from "effect";
import {
  cloudflare,
  config,
  defineRun,
  github,
  io,
  StepFailed,
  step,
  type DeploymentRef,
  type WorkflowRunRef,
} from "@flare-dispatch/core";
import { isoDate, parseList } from "@flare-dispatch/core/primitives";
import {
  completeStructured,
  namespacedKey,
  promptKey,
  resolveBackend,
} from "@flare-dispatch/review-agent";

const NAMESPACE = "ci-triage";
const key = namespacedKey(NAMESPACE);
const REPOS_KEY = key("repos");
const PROJECTS_KEY = key("projects");
const REPORT_REPO_KEY = key("report-repo");
const BASE_KEY = key("base");
const WINDOW_KEY = key("window-hours");

const DEFAULT_WINDOW_HOURS = 24;
const TRIAGE_MAX_TOKENS = 3072;

/** The model's triage of the day's failures. */
const TriageReport = Schema.Struct({
  /** A 1–2 sentence overview of the day's CI health. */
  summary: Schema.String,
  /** One triage item per distinct failure cluster. */
  items: Schema.Array(
    Schema.Struct({
      /** Short title naming the failure. */
      title: Schema.String,
      /** Where it failed — e.g. "github-actions" | "cloudflare-pages". */
      area: Schema.String,
      /** The most likely root cause, in one or two sentences. */
      diagnosis: Schema.String,
      /** A concrete suggested next step. */
      suggestedFix: Schema.String,
    }),
  ),
});

const DEFAULT_TRIAGE_PROMPT = `You triage continuous-integration failures.
You are given a list of recently-failed GitHub Actions workflow runs and
Cloudflare Pages deployments (repo / workflow / conclusion / branch / URL).
Cluster related failures, and for each cluster give a short title, the area it
failed in, the most likely root cause, and a concrete suggested next step.
Prefer a few high-signal items over many shallow ones. Be specific and
actionable; do not invent failures that aren't in the list. This is a triage
write-up for humans, not an automated fix.`;

const Input = Schema.Struct({
  firedAt: Schema.Number,
});

const Output = Schema.Struct({
  actionsFailures: Schema.Number,
  deployFailures: Schema.Number,
  prOpened: Schema.Boolean,
  prUpdated: Schema.Boolean,
  prNumber: Schema.Number,
});

export const ciTriagePr = defineRun({
  name: "ci-triage-pr",
  version: "1.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-review:latest",

  // Schedule mode: 06:00 UTC daily. Must also appear in wrangler.jsonc
  // `triggers.crons`.
  schedules: [
    {
      cron: "0 6 * * *",
      idempotencyKey: ({ firedAt }) => `ci-triage-pr:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1800, maxConcurrency: 4 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);
      const empty = {
        actionsFailures: 0,
        deployFailures: 0,
        prOpened: false,
        prUpdated: false,
        prNumber: 0,
      };

      // 1. Scope from config.
      const repos = parseList(yield* step("resolve-repos", () => config.get(REPOS_KEY)));
      const projects = parseList(
        yield* step("resolve-projects", () => config.get(PROJECTS_KEY)),
      );
      if (repos.length === 0 && projects.length === 0) {
        yield* step("log-empty", () =>
          io.log(
            "warn",
            `ci-triage-pr: neither ${REPOS_KEY} nor ${PROJECTS_KEY} is set — nothing to triage`,
          ),
        );
        return empty;
      }
      const windowHours =
        Number.parseInt(
          (yield* step("resolve-window", () => config.get(WINDOW_KEY))) ?? "",
          10,
        ) || DEFAULT_WINDOW_HOURS;
      const baseBranch =
        (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const reportRepo =
        (yield* step("resolve-report-repo", () => config.get(REPORT_REPO_KEY))) ??
        repos[0];
      if (reportRepo === undefined) {
        // CF projects configured but no repo to open the triage PR on.
        yield* step("log-no-report-repo", () =>
          io.log(
            "warn",
            `ci-triage-pr: no ${REPORT_REPO_KEY} and no ${REPOS_KEY} — nowhere to open the triage PR`,
          ),
        );
        return empty;
      }

      // 2. Read the failures (read capabilities — github.actionRuns +
      //    cloudflare.deployments). Both degrade to empty when uncredentialed.
      const actionFailures =
        repos.length === 0
          ? []
          : yield* step("read-actions", () =>
              github.actionRuns({
                repos,
                status: "completed",
                conclusion: "failure",
                createdWithinHours: windowHours,
              }),
            );
      const deployFailures =
        projects.length === 0
          ? []
          : yield* step("read-deploys", () =>
              cloudflare.deployments({
                projects,
                status: "failure",
                createdWithinHours: windowHours,
              }),
            );

      if (actionFailures.length === 0 && deployFailures.length === 0) {
        yield* step("log-green", () =>
          io.log("info", "ci-triage-pr: no CI failures in window — nothing to triage"),
        );
        return empty;
      }

      // 3. Resolve the configurable backend (the ai-code-review machinery, under
      //    this run's `ci-triage.*` namespace).
      const resolved = yield* step("resolve-backend", () =>
        resolveBackend((key) => config.get(key), { namespace: NAMESPACE }),
      ).pipe(
        Effect.catchTag("BackendUnconfigured", (e) =>
          Effect.fail(
            new StepFailed({
              step: "resolve-backend",
              cause: `ci-triage backend "${e.backend}" misconfigured — set ${e.missing}`,
            }),
          ),
        ),
      );
      const systemPrompt =
        (yield* step("resolve-prompt", () => config.get(promptKey(NAMESPACE)))) ??
        DEFAULT_TRIAGE_PROMPT;

      // 4. Triage via the reusable structured-output engine. A model failure is
      //    a real failure for a triage run (its whole job is the write-up), so
      //    it fails the run honestly as a StepFailed.
      const report = yield* step("triage", () =>
        completeStructured({
          backend: resolved.backend,
          model: resolved.model,
          mode: resolved.mode,
          system: systemPrompt,
          userBody: renderUserBody({ actionFailures, deployFailures }),
          jsonContract: TRIAGE_JSON_CONTRACT,
          schema: TriageReport,
          toolName: "report_triage",
          toolDescription: "Report the triage of the day's CI failures.",
          surface: "ci-triage",
          maxTokens: TRIAGE_MAX_TOKENS,
        }),
      ).pipe(
        Effect.catchTags({
          ModelCallFailed: (e) =>
            Effect.fail(
              new StepFailed({ step: "triage", cause: `model call failed: ${e.message}` }),
            ),
          StructuredOutputInvalid: (e) =>
            Effect.fail(
              new StepFailed({ step: "triage", cause: `unparseable triage output: ${e.message}` }),
            ),
        }),
      );

      // 5. Open/update the single daily triage draft PR.
      const result = yield* step("open-pr", () =>
        github.openDraftPullRequest({
          repo: reportRepo,
          baseBranch,
          headBranch: `flare-dispatch/ci-triage-${day}`,
          title: `chore(ci): triage ${day} CI failures`,
          body: renderPrBody(report, actionFailures.length, deployFailures.length),
          commitMessage: `chore(ci): CI failure triage for ${day}\n\nGenerated by flare-dispatch ci-triage-pr.`,
          files: [
            {
              path: `.flare-dispatch/ci-triage-${day}.md`,
              content: renderReportFile(report, actionFailures, deployFailures, day),
            },
          ],
        }),
      );

      yield* io.log(
        "info",
        `ci-triage-pr: ${result.created ? "opened" : "updated"} draft PR #${result.number} on ${reportRepo}`,
      );

      return {
        actionsFailures: actionFailures.length,
        deployFailures: deployFailures.length,
        prOpened: result.created,
        prUpdated: !result.created,
        prNumber: result.number,
      };
    }),
});

// --- Prompt + report rendering ----------------------------------------------

/** The compact JSON shape the model must emit (engine appends it in json mode). */
const TRIAGE_JSON_CONTRACT = `{"summary":string,"items":[{"title":string,"area":string,"diagnosis":string,"suggestedFix":string}]}`;

const failureLines = (
  actions: readonly WorkflowRunRef[],
  deploys: readonly DeploymentRef[],
): string => {
  const a = actions.map(
    (r) =>
      `- [github-actions] ${r.repo} · "${r.name}" on ${r.headBranch} → ${r.conclusion} (${r.url})`,
  );
  const d = deploys.map(
    (x) =>
      `- [cloudflare-pages] ${x.project} · ${x.environment} on ${x.branch} → ${x.status} (${x.url})`,
  );
  return [...a, ...d].join("\n");
};

/** The domain body of the user message (the engine appends the per-mode framing). */
const renderUserBody = (ctx: {
  actionFailures: readonly WorkflowRunRef[];
  deployFailures: readonly DeploymentRef[];
}): string =>
  [
    "Recent CI failures to triage:",
    "",
    failureLines(ctx.actionFailures, ctx.deployFailures),
  ].join("\n");

const MARKER = "<!-- flare-dispatch: ci-triage-pr -->";

const renderPrBody = (
  report: typeof TriageReport.Type,
  actions: number,
  deploys: number,
): string =>
  [
    `### CI triage — ${actions} Actions + ${deploys} deploy failure(s)`,
    "",
    "> 🤖 Draft opened by `flare-dispatch/ci-triage-pr`. A model-written triage of recent CI failures — review the suggested next steps; this is a diagnosis, not an automated fix.",
    "",
    report.summary.trim(),
    "",
    "#### Items",
    ...report.items.map((i) => `- **${i.title}** (${i.area}) — ${i.diagnosis}`),
    "",
    `Full triage committed to \`.flare-dispatch/ci-triage-*.md\`.`,
    "",
    MARKER,
  ].join("\n");

const renderReportFile = (
  report: typeof TriageReport.Type,
  actions: readonly WorkflowRunRef[],
  deploys: readonly DeploymentRef[],
  day: string,
): string =>
  [
    `# CI failure triage — ${day}`,
    "",
    report.summary.trim(),
    "",
    "## Triage",
    ...report.items.flatMap((i) => [
      `### ${i.title}`,
      `- **Area:** ${i.area}`,
      `- **Diagnosis:** ${i.diagnosis}`,
      `- **Suggested fix:** ${i.suggestedFix}`,
      "",
    ]),
    "## Raw failures",
    failureLines(actions, deploys),
    "",
  ].join("\n");
