// Recipe: weekly FinOps audit of execution cost → draft PR — the `finops-audit`
// Run (teaching copy; canonical impl: runs/finops-audit.ts).
//
// Reads the account's Cloudflare usage (Worker invocations + AI inference by
// model, via the read-only `cloudflare.usage` capability), asks a model to
// surface cost optimizations, and opens ONE draft PR with the write-up. Reuses
// the ai-code-review engine under the `finops.*` CONFIG_KV namespace. No
// container. See ./README.md for the config + the Account Analytics:Read scope.

import { Effect, Schema } from "effect";
import {
  type CloudflareUsage,
  cloudflare,
  config,
  defineRun,
  github,
  io,
  StepFailed,
  step,
} from "@flare-dispatch/core";
import { isoDate } from "@flare-dispatch/core/primitives";
import {
  completeStructured,
  namespacedKey,
  resolveBackend,
} from "@flare-dispatch/review-agent";

const key = namespacedKey("finops");

const FinOpsReport = Schema.Struct({
  summary: Schema.String,
  optimizations: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      area: Schema.String,
      finding: Schema.String,
      recommendation: Schema.String,
      estimatedImpact: Schema.String,
    }),
  ),
});

const PROMPT = `You are a FinOps analyst for a CI/CD platform on Cloudflare (Workers, Containers,
Workers AI via an AI Gateway). Given Worker invocations + errors by script and AI
requests + cache hits by model, surface concrete cost optimizations for the
executions (cap fan-out, cheaper models, raise cache TTL on low-hit hot models,
cut retry waste). Use the numbers; don't invent metrics.`;

export const finopsAudit = defineRun({
  name: "finops-audit",
  version: "1.0.0",
  schedules: [
    {
      cron: "0 7 * * 1", // Mondays 07:00 UTC — also add to wrangler triggers.crons
      idempotencyKey: ({ firedAt }) => `finops-audit:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],
  inputs: Schema.Struct({ firedAt: Schema.Number }),
  outputs: Schema.Struct({ optimizations: Schema.Number, prOpened: Schema.Boolean }),
  limits: { maxDurationSec: 1800, maxConcurrency: 1 },

  run: ({ firedAt }) =>
    Effect.gen(function* () {
      const day = isoDate(firedAt);
      const reportRepo = yield* step("repo", () => config.get(key("report-repo")));
      if (!reportRepo) return { optimizations: 0, prOpened: false };

      // 1. Read the cost picture.
      const usage: CloudflareUsage = yield* step("usage", () =>
        cloudflare.usage({ windowHours: 168 }),
      );
      if (usage.workers.length === 0 && usage.ai.length === 0) {
        yield* io.log("info", "finops-audit: no usage to analyse");
        return { optimizations: 0, prOpened: false };
      }

      // 2. Analyse via the configurable review engine.
      const resolved = yield* step("backend", () =>
        resolveBackend((k) => config.get(k), { namespace: "finops" }),
      );
      const report = yield* step("analyse", () =>
        completeStructured({
          backend: resolved.backend,
          model: resolved.model,
          mode: resolved.mode,
          system: PROMPT,
          userBody: usage.ai
            .map((a) => `${a.provider}/${a.model}: ${a.requests} req, ${a.cached} cached`)
            .join("\n"),
          jsonContract: `{"summary":string,"optimizations":[{"title":string,"area":string,"finding":string,"recommendation":string,"estimatedImpact":string}]}`,
          schema: FinOpsReport,
          toolName: "report_finops",
          toolDescription: "Report the FinOps optimizations.",
          surface: "finops",
          maxTokens: 3072,
        }),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.fail(new StepFailed({ step: "analyse", cause: String(e) })),
        ),
      );

      // 3. Open the weekly audit draft PR.
      const result = yield* step("pr", () =>
        github.openDraftPullRequest({
          repo: reportRepo,
          baseBranch: "main",
          headBranch: `flare-dispatch/finops-${day}`,
          title: `chore(finops): execution-cost audit ${day}`,
          body: `${report.summary}\n\n${report.optimizations.map((o) => `- **${o.title}** — ${o.recommendation}`).join("\n")}`,
          commitMessage: `chore(finops): cost audit ${day}`,
          files: [{ path: `.flare-dispatch/finops-${day}.md`, content: report.summary }],
        }),
      );
      return { optimizations: report.optimizations.length, prOpened: result.created };
    }),
});
