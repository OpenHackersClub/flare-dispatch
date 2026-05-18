// Recipe: post-deploy smoke test
//
// Use case: after a deploy succeeds, hit the live URL and a few critical
// endpoints; fail a check-run on the deployed SHA if anything is down.
//
// Mode: Webhook mode — fires on `deployment_status.success`, no GHA workflow
//       file. Drop this file into your repo's `runs/` directory; the
//       FlareDispatch GitHub App webhook does the rest. An Action-mode
//       alternative (./ci.yml) dispatches the same run from a GitHub Actions
//       workflow, for repos that cannot install the App.
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
      // only the success transition, only production, and only when GitHub
      // actually gave us a URL to probe — `environment_url` is optional in
      // the payload, and without it `baseURL` would be empty.
      gate: ({ payload }) =>
        payload.deployment_status.state === "success" &&
        payload.deployment.environment === "production" &&
        !!payload.deployment_status.environment_url,
      // key on the deployment id, not the commit: the same SHA can be
      // deployed many times (rollback-forward, redeploy) and each deploy
      // must get its own smoke test rather than collapsing onto the first.
      idempotencyKey: ({ payload }) =>
        `deploy-smoke:${payload.repository.full_name}:${payload.deployment.id}`,
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
            // No `-f`: with `-f`, curl exits non-zero on HTTP >= 400 and the
            // command's failure would be a *result* to inspect, not an Effect
            // failure (see specs/03-dsl.md § sandbox) — but relying on that is
            // fragile. Without `-f`, curl exits 0 for any HTTP response and
            // writes the status code to stdout; a non-zero exit then means the
            // request itself failed (DNS, connection refused). Both are
            // classified below.
            sandbox.exec({
              command: [
                "curl", "-sS", "-o", "/dev/null",
                "-w", "%{http_code}",
                `${input.baseURL}${path}`,
              ],
            }),
          { concurrency: input.paths.length },
        ),
      );

      // A probe failed if the request didn't complete (exitCode !== 0) or the
      // endpoint answered with a non-2xx/3xx status.
      const failed = results.filter((r) => {
        const code = Number(r.stdout.trim());
        return r.exitCode !== 0 || !(code >= 200 && code < 400);
      }).length;
      yield* io.log(
        failed === 0 ? "info" : "error",
        `deploy-smoke: ${results.length - failed}/${results.length} endpoints healthy`,
      );

      // A non-zero `failed` count fails the check-run on the deployed SHA.
      return { checked: results.length, failed };
    }),
});
