// Recipe: post-deploy smoke test
//
// Use case: after a deploy succeeds, hit the live URL and a few critical
// endpoints; fail a check-run on the deployed SHA if anything is down.
//
// The probe-and-classify loop is the `probeHttp` primitive, so this recipe
// is just trigger config + a one-line health check. See specs/03-dsl.md
// § Primitives.
//
// Mode: Webhook mode — fires on `deployment_status.success`, no GHA workflow
//       file. Drop this file into your repo's `runs/` directory; the
//       FlareDispatch GitHub App webhook does the rest. An Action-mode
//       alternative (./ci.yml) dispatches the same run from a GitHub Actions
//       workflow, for repos that cannot install the App.
// DSL:  see specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, io } from "@flare-dispatch/core";
import { probeHttp } from "@flare-dispatch/core/primitives";

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
      // `probeHttp` hits every path in parallel and classifies each as
      // healthy or failed (non-2xx/3xx, or a request that never completed —
      // see the primitive's note on curl exit codes).
      const probe = yield* step("probe", () =>
        probeHttp({ baseURL: input.baseURL, paths: input.paths }),
      );

      yield* io.log(
        probe.failed === 0 ? "info" : "error",
        `deploy-smoke: ${probe.checked - probe.failed}/${probe.checked} endpoints healthy`,
      );

      // A non-zero `failed` count fails the check-run on the deployed SHA.
      return { checked: probe.checked, failed: probe.failed };
    }),
});
