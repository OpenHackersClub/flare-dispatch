// FlareDispatch Dispatcher — RunWorkflow: the V0 Workflow class.
//
// `RunWorkflow extends WorkflowEntrypoint` is the single Workflow bound as
// `RUNS_WORKFLOW`. Its `run(event, step)` is the bridge between CF Workflows
// and the Effect-TS run DSL:
//
//   1. resolve the run named in the dispatch event against the run registry
//      (V0: a one-entry registry → `offloadTest`);
//   2. decode the event's `inputs` against the run's `inputs` Schema;
//   3. build the per-execution `CFRuntimeLive` Layer, binding `StepRunner` to
//      the live CF `step` argument so every `step(...)` is a durable checkpoint;
//   4. run `run.run(input)` under an Effect runtime;
//   5. write the terminal `executions` status — the `finalize` boundary that
//      `offload-test` deliberately leaves to the Workflow (see runs/offload-
//      test.ts header note 1).
//
// The execution-row lifecycle (`startExecution` / `finishExecution`) is owned
// here, not in the run body: the run records its *steps*; the Workflow records
// the *execution*. Both go through the `ExecutionsService` so D1 has one
// writer.
//
// --- The GitHub check-run callback (PR6) -------------------------------------
//
// The other half of `finalize` is the GitHub check-run — the actual PR signal.
// `RunWorkflow` opens an `in_progress` check-run when the execution starts and
// completes it (`success` for a green run Exit, `failure` for red) when it
// finishes, via the `Checks` capability backed by `ChecksGithubLive`.
//
//   * The App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) come from
//     `env`; the installation id rides in the dispatch payload's
//     `github.installation_id` (PR5's dispatch route fills it in). When any of
//     the three is absent — local dev without secrets, or a dispatch with no
//     installation — `makeCFRuntimeLive` selects the *no-op* `Checks` Layer:
//     the execution runs to completion and records its D1 rows, only the PR
//     check-run is skipped. A missing check-run never fails an execution.
//   * The GitHub-assigned check-run id is persisted onto the `executions` row's
//     `check_run_id` column. The core `ExecutionsService` interface is
//     run-agnostic and carries no check-run method, so this single UPDATE is
//     issued directly against the D1 binding the Workflow already holds —
//     `RunWorkflow` owns the execution row, this is part of that ownership.
//
// Spec: specs/01-architecture.md § Workflow Engine + § Per-execution lifecycle,
//       specs/04-gha-integration.md § Check-runs callback,
//       specs/pm/plan.md § PR4 + § PR6.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Exit, Schedule, Schema } from "effect";
import { Checks, Email, Executions } from "@flare-dispatch/core";
import {
  type BrowserRenderingConfig,
  type ChecksGithubConfig,
  type EmailCloudflareConfig,
  makeCFRuntimeLive,
} from "@flare-dispatch/runtime-cf";
import { lookupRun } from "./registry";
import { renderResultEmail } from "./notify";
import type { Env } from "./env";

/** The repo/ref/sha context a dispatch carries — `04-gha-integration § body`. */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, { default: () => "refs/heads/main" }),
  sha: Schema.String,
  /**
   * The GitHub App installation id for the repo — needed to mint the
   * installation token the check-run callback authenticates with. Optional:
   * absent in local dev / direct dispatches without an installed App, in which
   * case the runtime degrades to the no-op `Checks` Layer. PR5's dispatch route
   * fills this in from the request body.
   */
  installation_id: Schema.optional(Schema.Number),
});

/**
 * The Workflow event payload — the dispatch body the Dispatcher's
 * `/v1/dispatch/:run` route forwards into `RUNS_WORKFLOW.create(...)`. PR5
 * owns that route; PR4 pins the shape `RunWorkflow` decodes.
 */
const DispatchPayload = Schema.Struct({
  /** the ULID assigned to this execution. */
  executionId: Schema.String,
  /** which run to execute — keyed into `RUN_REGISTRY`. */
  run: Schema.String,
  /** repo / ref / sha / installation — the `executions` row + check-run context. */
  github: GithubContext,
  /** the run inputs, decoded per-run against `run.inputs`. */
  inputs: Schema.Unknown,
  /**
   * Optional completion-notify recipients. When `emails` is non-empty, the
   * Workflow emails the run's verdict + output (artifact / demo / log links) to
   * each address at the finalize boundary, via the `email` capability. PR5's
   * dispatch route fills this in from the request body's `notify`. Delivery is
   * best-effort: a send failure is logged, never fails the run.
   */
  notify: Schema.optional(
    Schema.Struct({ emails: Schema.Array(Schema.String) }),
  ),
});
type DispatchPayload = Schema.Schema.Type<typeof DispatchPayload>;

/**
 * Resolve the `Checks` Layer config from `env` + the dispatch payload, or
 * `undefined` when any of the three required pieces (App id, PEM, installation
 * id) is absent — `undefined` selects the no-op `Checks` Layer.
 *
 * `installation_id <= 0` is treated as "absent": the dispatch route already
 * rejects 0 with a 400, but the scheduled-mode cron path and any direct
 * Workflow instantiation feed in raw numbers — guarding here too means a stray
 * 0 degrades to "no check-run posted" instead of dying inside
 * `getInstallationToken(0)`. Loud failure lives at the dispatch boundary; the
 * runtime stays resilient.
 */
const resolveChecksConfig = (
  env: Env,
  github: DispatchPayload["github"],
): ChecksGithubConfig | undefined => {
  if (
    env.GITHUB_APP_ID === undefined ||
    env.GITHUB_APP_PRIVATE_KEY === undefined ||
    github.installation_id === undefined ||
    github.installation_id <= 0
  ) {
    return undefined;
  }
  return {
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    installationId: github.installation_id,
  };
};

/**
 * Resolve the `Browser` Layer config from `env`, or `undefined` when Browser
 * Rendering is not configured — `undefined` selects the dying `Browser` stub.
 * Only browser runs (`cdp-acceptance`) touch the Tag; others are unaffected.
 */
const resolveBrowserConfig = (env: Env): BrowserRenderingConfig | undefined =>
  env.BROWSER_CDP_CONNECT_URL === undefined
    ? undefined
    : {
        connectUrl: env.BROWSER_CDP_CONNECT_URL,
        apiToken: env.BROWSER_CDP_API_TOKEN,
      };

/**
 * Resolve the `Email` Layer config from `env`, or `undefined` when Email
 * Routing is not configured (no `SEND_EMAIL` binding or no `EMAIL_FROM`
 * sender) — `undefined` selects the no-op `Email` Layer (notifications logged
 * + skipped). `EMAIL_ALLOWED_RECIPIENTS`, when set, is split on commas into an
 * operator allowlist.
 */
const resolveEmailConfig = (env: Env): EmailCloudflareConfig | undefined => {
  if (env.SEND_EMAIL === undefined || env.EMAIL_FROM === undefined) {
    return undefined;
  }
  const allowed = env.EMAIL_ALLOWED_RECIPIENTS?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    sendEmail: env.SEND_EMAIL,
    fromAddress: env.EMAIL_FROM,
    ...(env.EMAIL_FROM_NAME !== undefined
      ? { fromName: env.EMAIL_FROM_NAME }
      : {}),
    ...(allowed !== undefined && allowed.length > 0
      ? { allowedRecipients: allowed }
      : {}),
  };
};

/**
 * The Cloudflare Workflows name backing `RUNS_WORKFLOW` — the dashboard
 * URL segment. MUST stay in sync with `wrangler.jsonc` → `workflows[0].name`.
 */
const WORKFLOWS_DASHBOARD_NAME = "runs-workflow";

/**
 * Build the Cloudflare dashboard deep-link for this execution's Workflow
 * instance (the `executionId` doubles as the CF Workflow `instanceId` —
 * `RUNS_WORKFLOW.create({ id: executionId })`), or `undefined` when the
 * account id is not configured (the BYOC default). Used as the check-run's
 * `details_url` so a reviewer jumps from the PR check to the step logs.
 */
const workflowDashboardUrl = (
  accountId: string | undefined,
  executionId: string,
): string | undefined =>
  accountId !== undefined && accountId.length > 0
    ? `https://dash.cloudflare.com/${accountId}/workers/workflows/${WORKFLOWS_DASHBOARD_NAME}/instance/${encodeURIComponent(executionId)}`
    : undefined;

export class RunWorkflow extends WorkflowEntrypoint<Env> {
  override async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<void> {
    // Decode the dispatch payload — a malformed event is a hard failure.
    const payload: DispatchPayload = Schema.decodeUnknownSync(DispatchPayload)(
      event.payload,
    );

    const run = lookupRun(payload.run);
    if (run === undefined) {
      throw new Error(`RunWorkflow: unknown run "${payload.run}"`);
    }

    // Decode the run inputs against the run's own Schema — a contract mismatch
    // fails before any container boots.
    const input = Schema.decodeUnknownSync(run.inputs)(payload.inputs);

    // Build the per-execution live runtime: D1 + R2 + Containers + Checks, with
    // `StepRunner` bound to *this* Workflow's `step` so each `step(...)` in the
    // run body is a real durable `WorkflowStep.do(...)` checkpoint.
    const db = this.env.RUNS_METADATA;
    const checkRunName = `flare-dispatch/${payload.run}`;
    // The Cloudflare Workflows instance page for this execution — the "Details"
    // link on the GitHub check-run + a markdown link in its summary. `undefined`
    // when CLOUDFLARE_ACCOUNT_ID is unset (BYOC default): the check-run renders
    // exactly as before, no link.
    const detailsUrl = workflowDashboardUrl(
      this.env.CLOUDFLARE_ACCOUNT_ID,
      payload.executionId,
    );
    const runtime = makeCFRuntimeLive({
      db,
      bucket: this.env.RUNS_STORAGE,
      sandboxNs: this.env.RUNS_SANDBOX,
      workflowStep: step,
      executionId: payload.executionId,
      execution: {
        repo: payload.github.repo,
        ref: payload.github.ref,
        sha: payload.github.sha,
        input,
      },
      checks: resolveChecksConfig(this.env, payload.github),
      configKv: this.env.CONFIG_KV,
      browser: resolveBrowserConfig(this.env),
      email: resolveEmailConfig(this.env),
      // Workers AI binding backs the `modelGateway` capability (the `pr-review`
      // engine's model backend). The binding is the auth — no model API key.
      // `AI_GATEWAY_ID`, when set, routes the calls through an AI Gateway.
      ...(this.env.AI !== undefined ? { ai: this.env.AI } : {}),
      ...(this.env.AI_GATEWAY_ID !== undefined
        ? { aiGatewayId: this.env.AI_GATEWAY_ID }
        : {}),
      sandboxPreviewHostname: this.env.SANDBOX_PREVIEW_HOSTNAME,
      // Wire the live OIDC signing Layer when both the JWK + issuer URL are
      // configured. Subject defaults to `<run>:<execution-id>` so an IAM
      // trust policy can scope a role to a single run+execution.
      ...(this.env.OIDC_SIGNING_JWK !== undefined &&
      this.env.OIDC_ISSUER_URL !== undefined
        ? {
            oidc: {
              signingJwkJson: this.env.OIDC_SIGNING_JWK,
              issuerUrl: this.env.OIDC_ISSUER_URL,
              defaultSubject: `${payload.run}:${payload.executionId}`,
            },
          }
        : {}),
    });

    // The execution program — the `finalize` boundary:
    //   1. open the `executions` row;
    //   2. open the `in_progress` check-run, persist its id on the row;
    //   3. run the run Effect to an `Exit` (a run-level failure is *data*, a
    //      recorded `failure` row + a `failure` check-run conclusion — never a
    //      thrown Workflow infra error);
    //   4. write the terminal `executions` status + complete the check-run.
    const program = Effect.gen(function* () {
      const executions = yield* Executions;
      const checks = yield* Checks;
      const email = yield* Email;

      const startedAt = yield* Effect.sync(() => Date.now());
      yield* executions.startExecution({
        id: payload.executionId,
        run: payload.run,
        startedAt,
      });

      // Open the check-run (`in_progress`). With no App config this resolves
      // to the no-op sentinel id and posts nothing.
      const checkRunId = yield* checks.create({
        repo: payload.github.repo,
        sha: payload.github.sha,
        name: checkRunName,
        ...(detailsUrl !== undefined ? { detailsUrl } : {}),
        output: {
          title: checkRunName,
          summary:
            detailsUrl !== undefined
              ? `Execution [\`${payload.executionId}\`](${detailsUrl}) started — [view step logs in Cloudflare ↗](${detailsUrl})`
              : `Execution \`${payload.executionId}\` started.`,
        },
      });
      // Persist the GitHub check-run id onto the `executions` row.
      // D1 write for check_run_id — best-effort metadata, retry once on
      // transient errors then die (the execution and check-run are already
      // complete; losing the check_run_id on the D1 row is a minor loss).
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE executions SET check_run_id = ? WHERE id = ?`)
          .bind(checkRunId, payload.executionId)
          .run(),
      ).pipe(
        Effect.retry(
          Schedule.once.pipe(Schedule.addDelay(() => "500 millis")),
        ),
        Effect.orDie,
      );

      const exit = yield* Effect.exit(run.run(input));
      const completedAt = yield* Effect.sync(() => Date.now());

      const status = Exit.match(exit, {
        onSuccess: () => "success" as const,
        onFailure: () => "failure" as const,
      });

      // Persist the run output as JSON so `io.priorExecution` can recover it
      // on the next execution in the semantic family. A failed Exit has no
      // output; the column stays NULL.
      const summaryJson = Exit.match(exit, {
        onSuccess: (out) => {
          try {
            return JSON.stringify(out);
          } catch {
            return undefined;
          }
        },
        onFailure: () => undefined,
      });

      yield* executions.finishExecution({
        id: payload.executionId,
        completedAt,
        status,
        ...(summaryJson !== undefined ? { summaryJson } : {}),
      });

      // Complete the check-run with the run's verdict.
      const logsSuffix =
        detailsUrl !== undefined
          ? ` — [view step logs in Cloudflare ↗](${detailsUrl})`
          : "";
      yield* checks.update({
        repo: payload.github.repo,
        checkRunId,
        conclusion: status,
        ...(detailsUrl !== undefined ? { detailsUrl } : {}),
        output: {
          title: checkRunName,
          summary: Exit.match(exit, {
            onSuccess: () =>
              `✓ ${payload.run} — execution succeeded.${logsSuffix}`,
            onFailure: () => `✗ ${payload.run} — execution failed.${logsSuffix}`,
          }),
        },
      });

      // Completion-notify email — the other side of the GitHub check-run, for
      // recipients who aren't watching the PR. Renders the run's verdict +
      // output (artifact / demo / log links) and sends to each `notify.emails`
      // address. Best-effort: a send failure (or an unconfigured backend) is
      // logged, never failing the already-finished run.
      const notifyEmails = payload.notify?.emails ?? [];
      if (notifyEmails.length > 0) {
        const rendered = renderResultEmail({
          run: payload.run,
          status,
          executionId: payload.executionId,
          repo: payload.github.repo,
          sha: payload.github.sha,
          ...(detailsUrl !== undefined ? { detailsUrl } : {}),
          output: Exit.match(exit, {
            onSuccess: (out) => out,
            onFailure: () => undefined,
          }),
        });
        yield* email
          .send({
            to: notifyEmails,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          })
          .pipe(
            Effect.tap((result) =>
              Effect.logInfo(
                `notify: emailed ${result.accepted.length}/${notifyEmails.length} recipient(s)` +
                  (result.rejected.length > 0
                    ? ` (${result.rejected.length} rejected)`
                    : ""),
              ),
            ),
            // `send` is total, but guard defects so a notify bug never turns a
            // green run red at the very last step.
            Effect.catchAllCause((cause) =>
              Effect.logError(`notify: email send failed — ${cause}`),
            ),
          );
      }
    });

    await Effect.runPromise(program.pipe(Effect.provide(runtime)));
  }
}
