// Recipe: security / dependency scan — the `security-scan` Run
//
// The typed Run that ./ci.yml dispatches. Runs each selected scanner in its
// own container, in parallel, and fails the check-run if any scanner exits
// non-zero (each scanner is configured to exit non-zero at/above `failOn`).
//
// This is the shipped `security-scan` run, reproduced here so the recipe is
// self-contained. Spec: specs/02-runs.md § 5. DSL: specs/03-dsl.md.

import { Effect, Schema } from "effect";
import { defineRun, step, sandbox, artifact } from "@flare-dispatch/core";

const Scanner = Schema.Literal(
  "npm-audit", "pnpm-audit", "cargo-audit", "uv-audit",
  "trivy-fs", "grype-fs", "gitleaks",
);

const Input = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  scanners: Schema.Array(Scanner),
  failOn: Schema.optional(Schema.Literal("any", "high", "critical")), // default "high"
});

const Output = Schema.Struct({
  failed: Schema.Boolean,
  scannerResults: Schema.Array(
    Schema.Struct({
      scanner: Schema.String,
      exitCode: Schema.Number,
      reportUri: Schema.String,
    }),
  ),
});

export const securityScan = defineRun({
  name: "security-scan",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 1200, maxConcurrency: 4 },

  run: (input) =>
    Effect.gen(function* () {
      const failOn = input.failOn ?? "high";

      const scannerResults = yield* step("scan", () =>
        Effect.forEach(
          input.scanners,
          (scanner) =>
            Effect.gen(function* () {
              const container = yield* sandbox.acquire({});
              const dir = yield* sandbox.git.clone({
                repo: input.repo,
                sha: input.sha,
                container,
              });
              const exec = yield* sandbox.exec({
                cwd: dir,
                container,
                env: { FAIL_ON: failOn },
                // `scan` is a thin wrapper in the base image that normalizes
                // each scanner's flags and exit codes against FAIL_ON.
                command: ["scan", scanner],
              });
              const reportUri = yield* artifact.upload({
                name: `${scanner}-report.json`,
                path: exec.logPath,
                container,
              });
              return { scanner, exitCode: exec.exitCode, reportUri };
            }),
          { concurrency: 4 },
        ),
      );

      const failed = scannerResults.some((r) => r.exitCode !== 0);
      return { failed, scannerResults };
    }),
});
