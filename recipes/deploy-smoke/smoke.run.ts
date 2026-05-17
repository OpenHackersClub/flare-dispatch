// Recipe: post-deploy smoke test
//
// Use case: after a deploy succeeds, hit the live URL and a few critical
// endpoints; fail a check-run on the deployed SHA if anything is down.
//
// Mode: Webhook mode — fires on `deployment_status.success`, no GHA workflow
//       file. Drop this file into your repo's `runs/` directory; the
//       FlareDispatch GitHub App webhook does the rest.
// DSL:  see specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, io } from "@flaredispatch/core";

export const deploySmoke = defineRun({
  name: "deploy-smoke",
  version: "1.0.0",

  // Webhook-mode trigger config — the receiver-side equivalent of a GHA
  // `on:` filter. See specs/04-gha-integration.md#webhook-mode.
  triggers: [
    {
      event: "deployment_status",
      // only the success transition, and only for production deploys
      gate: ({ payload }) =>
        payload.deployment_status.state === "success" &&
        payload.deployment.environment === "production",
      idempotencyKey: ({ payload }) =>
        `deploy-smoke:${payload.repository.full_name}:${payload.deployment.sha}`,
      inputs: ({ payload }) => ({
        repo: payload.repository.full_name,
        sha: payload.deployment.sha,
        baseURL: payload.deployment_status.environment_url,
        paths: ["/", "/health", "/api/status"],
      }),
    },
  ],

  inputs: Schema.Struct({
    repo: Schema.String,
    sha: Schema.String,
    baseURL: Schema.String,
    paths: Schema.Array(Schema.String),
  }),

  outputs: Schema.Struct({
    checked: Schema.Number,
    failed: Schema.Number,
  }),

  limits: { maxDurationSec: 300 },

  run: (input) =>
    Effect.gen(function* () {
      const results = yield* step("probe", () =>
        Effect.forEach(
          input.paths,
          (path) =>
            sandbox.exec({
              // curl -f exits non-zero on any HTTP >= 400
              command: [
                "curl", "-fsS", "-o", "/dev/null",
                "-w", "%{http_code}",
                `${input.baseURL}${path}`,
              ],
            }),
          { concurrency: input.paths.length },
        ),
      );

      const failed = results.filter((r) => r.exitCode !== 0).length;
      yield* io.log(
        failed === 0 ? "info" : "error",
        `deploy-smoke: ${results.length - failed}/${results.length} endpoints healthy`,
      );

      // A non-zero `failed` count fails the check-run on the deployed SHA.
      return { checked: results.length, failed };
    }),
});
