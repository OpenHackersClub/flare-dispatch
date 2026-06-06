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
import { Duration, Effect, Exit, Schedule, Schema } from "effect";
import {
  admissionAcquireAttempts,
  type AdmissionPool,
  AdmissionTimedOut,
  Checks,
  decideAdmission,
  Email,
  Executions,
  type RunContext,
  type RunError,
} from "@flare-dispatch/core";
import {
  ADMISSION_MAX_QUEUE_AGE_MS,
  ADMISSION_POLL_EVERY_MS,
  type BrowserRenderingConfig,
  type ChecksGithubConfig,
  describeOutcome,
  type EmailCloudflareConfig,
  LEASE_HEARTBEAT_EVERY_MS,
  makeCFRuntimeLive,
  makeContainerLeaseD1,
  makeRunAdmissionD1,
  makeWritebackTokenMinter,
  previewSafeSandboxId,
  resolveAdmissionCap,
  runWriteback,
  type WritebackOutcome,
} from "@flare-dispatch/runtime-cf";
import { WRITEBACK_ARTIFACT } from "@flare-dispatch/core";
import { lookupRun } from "./registry";
import { selectSandboxNs } from "./sandbox-routing";
import { queuedSummary } from "./admission-summary";
import { appendFailureSummary, failureSummaryMd } from "./failure-summary";
import { renderResultEmail } from "./notify";
import { workflowDashboardUrl } from "./dashboard-url";
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
   * When this execution was spawned by a parent run via `spawnChildRun`, the
   * parent's execution id — persisted to `executions.parent_execution_id` so a
   * fan-out parent can enumerate its children. Absent for top-level
   * (dispatched / scheduled) executions. The `childRuns` capability's live
   * layer (`makeChildRunsLive`) sets it on every child's `create` params.
   */
  parentExecutionId: Schema.optional(Schema.String),
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
  /**
   * The dispatcher's public origin (e.g. `https://<worker>.workers.dev`) —
   * prefixed onto the `/v1/artifacts/...` URLs the run uploads so the links
   * embedded in check-run summaries are absolute (GitHub resolves relative
   * markdown links against `github.com`, breaking them). The dispatch route
   * captures it from `PUBLIC_ORIGIN` or the request URL; the scheduled path
   * and `RunWorkflow` itself fall back to `PUBLIC_ORIGIN`. Absent everywhere →
   * relative paths, as before.
   */
  origin: Schema.optional(Schema.String),
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
 * Resolve the GitHub App credentials for the `github` capability's read +
 * content-write surface (`actionRuns`, `openDraftPullRequest`), independent of
 * any per-dispatch `installation_id`. Schedule-mode runs (`spec-drift`,
 * `ci-triage`) carry no installation, so they can't ride `resolveChecksConfig`;
 * the capability resolves the per-repo installation itself. `undefined` when
 * the App secrets are absent → the write surface is a logged no-op.
 */
const resolveGithubAppConfig = (
  env: Env,
): { appId: string; privateKeyPem: string } | undefined =>
  env.GITHUB_APP_ID === undefined || env.GITHUB_APP_PRIVATE_KEY === undefined
    ? undefined
    : { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };

/**
 * Resolve the `Cloudflare` Layer config from `env` — a scoped API token + the
 * account id. `undefined` when either is absent → `CloudflareDeferred` (the
 * read-only capability returns empty). Only `ci-triage` touches the Tag.
 */
const resolveCloudflareConfig = (
  env: Env,
): { apiToken: string; accountId: string } | undefined =>
  env.CLOUDFLARE_API_TOKEN === undefined ||
  env.CLOUDFLARE_ACCOUNT_ID === undefined
    ? undefined
    : { apiToken: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID };

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

    // Route to the sandbox image the run declares (`sandboxImage: "browser"`
    // → the chromium-baked binding; default → lean). A DIFFERENT axis from
    // `limits.requiresBrowser` — see sandbox-routing.ts + define-run.ts
    // § SandboxImage. Degrades to lean when the browser container isn't bound.
    const sandboxNs = selectSandboxNs(run.sandboxImage, {
      lean: this.env.RUNS_SANDBOX,
      browser: this.env.RUNS_SANDBOX_BROWSER,
    });

    // The admission-semaphore pool key — the SAME routing rule as the binding
    // selection above (browser image without a bound browser container
    // degrades to lean), so a run is always metered against the pool whose
    // container it will actually consume.
    const admissionPool = selectSandboxNs<AdmissionPool>(run.sandboxImage, {
      lean: "lean",
      browser:
        this.env.RUNS_SANDBOX_BROWSER !== undefined ? "browser" : undefined,
    });
    // The per-pool slot cap, from the plain `ADMISSION_CAP` wrangler var
    // (one var for both pools; keep it ≤ each container's `max_instances` —
    // see the paired comments in wrangler.jsonc). Unset/unparsable → 16.
    const admissionCap = resolveAdmissionCap(this.env.ADMISSION_CAP);

    // Build the per-execution live runtime: D1 + R2 + Containers + Checks, with
    // `StepRunner` bound to *this* Workflow's `step` so each `step(...)` in the
    // run body is a real durable `WorkflowStep.do(...)` checkpoint.
    const db = this.env.RUNS_METADATA;
    // Captured for the post-run writeback step: the R2 bucket the container's
    // changed-files artifact landed in, and the App config that mints the
    // installation token the Worker (never the container) commits with.
    const bucket = this.env.RUNS_STORAGE;
    const githubAppConfig = resolveGithubAppConfig(this.env);
    const checkRunName = `flare-dispatch/${payload.run}`;
    // The Cloudflare Workflows instance page for this execution — the "Details"
    // link on the GitHub check-run + a markdown link in its summary. `undefined`
    // when CLOUDFLARE_ACCOUNT_ID is unset (BYOC default): the check-run renders
    // exactly as before, no link.
    const detailsUrl = workflowDashboardUrl(
      this.env.CLOUDFLARE_ACCOUNT_ID,
      payload.executionId,
    );
    // The public origin absolutizing artifact URLs: the dispatch request's
    // origin (captured by the route) wins; `PUBLIC_ORIGIN` covers payloads
    // that predate the field or came from the cron path.
    const publicOrigin = payload.origin ?? this.env.PUBLIC_ORIGIN;
    const runtime = makeCFRuntimeLive({
      db,
      bucket: this.env.RUNS_STORAGE,
      sandboxNs,
      workflowStep: step,
      // The `Workflow` binding backs the `childRuns` capability — a run can
      // `spawnChildRun` / `fanOut` to independent child `RunWorkflow` instances.
      runsWorkflow: this.env.RUNS_WORKFLOW,
      executionId: payload.executionId,
      execution: {
        repo: payload.github.repo,
        ref: payload.github.ref,
        sha: payload.github.sha,
        input,
      },
      checks: resolveChecksConfig(this.env, payload.github),
      ...(resolveGithubAppConfig(this.env) !== undefined
        ? { githubApp: resolveGithubAppConfig(this.env) }
        : {}),
      ...(resolveCloudflareConfig(this.env) !== undefined
        ? { cloudflare: resolveCloudflareConfig(this.env) }
        : {}),
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
      // `bedrock/*` model ids route through the AI Gateway Bedrock forwarder —
      // the URL needs the Cloudflare account id, and Authenticated Gateway (when
      // turned on) needs a separate `cf-aig-authorization` token. Both absent →
      // bedrock route fails with an operator-facing error, other routes ignore.
      ...(this.env.CLOUDFLARE_ACCOUNT_ID !== undefined
        ? { cloudflareAccountId: this.env.CLOUDFLARE_ACCOUNT_ID }
        : {}),
      ...(this.env.AI_GATEWAY_AUTH_TOKEN !== undefined
        ? { aiGatewayAuthToken: this.env.AI_GATEWAY_AUTH_TOKEN }
        : {}),
      sandboxPreviewHostname: this.env.SANDBOX_PREVIEW_HOSTNAME,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
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
        ...(payload.parentExecutionId !== undefined
          ? { parentExecutionId: payload.parentExecutionId }
          : {}),
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

      // --- Global run admission (the per-pool semaphore, issue #109) -------
      //
      // A merge burst can create more concurrent RunWorkflow instances than
      // the container pool has instances (`max_instances: 16` per class); the
      // excess runs boot anyway, fail `ContainerLaunchFailed` /
      // `PortNeverOpened`, and post red checks indistinguishable from test
      // failures. So before the run body — and before the per-container-id
      // lease below — every run passes a global, per-pool admission semaphore
      // in D1: enqueue FIFO, poll a bounded atomic-claim loop through durable
      // steps (a queued run hibernates for free in `step.sleep`), surface the
      // queue position on the in-progress check-run, and fail
      // `AdmissionTimedOut` once the dispatch-age ceiling lapses. The slot is
      // heartbeated for the whole run and released on every exit path.
      //
      // Nesting order: admission (outer, global) → container lease (inner,
      // per-container-id) → run body. A lease waiter holds an admission slot
      // while it waits — by design; there is no circular wait.
      //
      // Matrix-children hazard (ADR #109 note 2): a fan-out parent holds its
      // slot while `waitForChildren` blocks on children who would otherwise
      // queue behind OTHER parents — a starvation shape. Mitigated in
      // `enqueue`: a child (`parentExecutionId` set) inherits its parent's
      // `enqueued_at` as the FIFO key, jumping to the parent's place in line;
      // the dispatch-age timeout bounds the worst case loud, never a hang.
      const admissions = makeRunAdmissionD1(db, Date.now, admissionCap);
      // Wrap a raw CF durable step as an Effect. The gate runs its I/O in
      // `step.do` / `step.sleep` (NOT the run DSL's StepRunner — these steps
      // precede the run body) so every clock read + claim is checkpointed and
      // a replay re-reads the recorded result. A rejected step promise is
      // platform/infra breakage → defect (`orDie`), keeping the gate's typed
      // error channel a clean `AdmissionTimedOut`.
      // CF types `step.do<T extends Rpc.Serializable<T>>`; the admission step
      // results are plain JSON records, so bridge through the simple
      // `(name, callback)` view — the same narrowing `step-runner-cf.ts` uses
      // for its `WorkflowStepLike`.
      const stepDo = <T>(
        name: string,
        body: () => Promise<T>,
      ): Effect.Effect<T> =>
        Effect.tryPromise(() =>
          (
            step.do as unknown as (
              n: string,
              cb: () => Promise<T>,
            ) => Promise<T>
          )(name, body),
        ).pipe(Effect.orDie);

      const admissionGate: Effect.Effect<void, AdmissionTimedOut> = Effect.gen(
        function* () {
          // Enqueue — the row's `enqueued_at` (FIFO key + dispatch-age basis)
          // is read inside the step, so a replay sees the SAME timestamp.
          const { enqueuedAt } = yield* stepDo("admission-enqueue", () =>
            Effect.runPromise(
              admissions.enqueue(
                payload.executionId,
                admissionPool,
                payload.parentExecutionId,
              ),
            ),
          );

          // Bounded claim/sleep loop — a COUNT (≤60 claims + 60 sleeps at the
          // defaults), not a wall-clock read, so the bound is replay-stable
          // and trivial against the Workflows step cap (#83 precedent).
          const maxAttempts = admissionAcquireAttempts(
            ADMISSION_MAX_QUEUE_AGE_MS,
            ADMISSION_POLL_EVERY_MS,
          );
          let lastReportedPosition: number | undefined;

          for (let i = 0; i < maxAttempts; i++) {
            const observed = yield* stepDo(`admission-claim-${i}`, () =>
              Effect.runPromise(
                admissions.attempt(
                  payload.executionId,
                  admissionPool,
                  enqueuedAt,
                ),
              ),
            );
            const decision = decideAdmission(
              observed,
              enqueuedAt,
              observed.now,
              ADMISSION_MAX_QUEUE_AGE_MS,
            );

            if (decision._kind === "admit") return;
            if (decision._kind === "timeout") {
              return yield* Effect.fail(
                new AdmissionTimedOut({
                  queuedForMs: decision.queuedForMs,
                  position: decision.position,
                  poolBusy: decision.poolBusy,
                }),
              );
            }

            // `wait`: surface the queue position on the in-progress check-run
            // — only when it CHANGED, bounding GitHub API writes to at most
            // one per drained peer. Best-effort: a GitHub blip while queued
            // must never kill the run.
            if (decision.position !== lastReportedPosition) {
              lastReportedPosition = decision.position;
              yield* checks
                .progress({
                  repo: payload.github.repo,
                  checkRunId,
                  ...(detailsUrl !== undefined ? { detailsUrl } : {}),
                  output: {
                    title: checkRunName,
                    summary: queuedSummary(
                      decision.position,
                      decision.poolBusy,
                      admissionCap,
                      enqueuedAt + ADMISSION_MAX_QUEUE_AGE_MS,
                    ),
                  },
                })
                .pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.logWarning(
                      `admission: queue-position update failed — ${cause}`,
                    ),
                  ),
                );
            }

            // Durable, free hibernation between polls. Don't sleep after the
            // final attempt — fall straight through to timeout.
            if (i < maxAttempts - 1) {
              yield* Effect.tryPromise(() =>
                step.sleep(`admission-wait-${i}`, ADMISSION_POLL_EVERY_MS),
              ).pipe(Effect.orDie);
            } else {
              return yield* Effect.fail(
                new AdmissionTimedOut({
                  queuedForMs: Math.max(0, observed.now - enqueuedAt),
                  position: decision.position,
                  poolBusy: decision.poolBusy,
                }),
              );
            }
          }
          // Unreachable — the final attempt returns or fails above.
          return yield* Effect.fail(
            new AdmissionTimedOut({
              queuedForMs: ADMISSION_MAX_QUEUE_AGE_MS,
              position: 0,
              poolBusy: 0,
            }),
          );
        },
      );

      // --- Per-container-id serialization (the lease) ----------------------
      //
      // Two runs whose execution ids normalise to the SAME sandbox container id
      // (e.g. `playwright-demo` + `product-demo` for one repo+sha, both
      // `demo-<owner>-<repo>-<sha12>`) route to the same Durable Object and, run
      // concurrently, contend — interleaved exec sessions, Browser Rendering
      // pool contention — and fail nearly every time on a merge burst even
      // though each passes solo. Acquire a lease on the container id before the
      // run touches its container, hold it (heartbeating) for the run, release
      // it after. A peer for the same id WAITS for us, then runs cleanly.
      //
      // `acquireUseRelease`: the heartbeat fiber + lease are torn down on EVERY
      // exit path (success / run failure / defect / interrupt). A failed acquire
      // (`ContainerBusy` after the wait ceiling) flows into `exit` as a normal
      // `failure` — recorded + reported like any other run failure, never a
      // thrown infra error.
      const containerId = previewSafeSandboxId(payload.executionId);
      const leaseStore = makeContainerLeaseD1(db);
      const leased: Effect.Effect<unknown, RunError, RunContext> = Effect.gen(
        function* () {
          const lease = yield* leaseStore.acquire(
            containerId,
            payload.executionId,
          );
          // Keep the heartbeat fresh in the background so a long run (a 25-min
          // matrix) is never reclaimed as stale mid-flight. Each beat swallows
          // its own error so a transient D1 blip never propagates; forked into
          // the scope, interrupted when the scope closes; the lease is released
          // on EVERY exit path via `ensuring`. (The admission slot has its own
          // beat fiber one scope OUT — see `admissionHeld` below — because it
          // must stay fresh through the lease-acquire WAIT, too.)
          const heartbeatLoop: Effect.Effect<void, never> = lease
            .heartbeat()
            .pipe(
              Effect.ignore,
              Effect.repeat(
                Schedule.spaced(Duration.millis(LEASE_HEARTBEAT_EVERY_MS)),
              ),
              Effect.asVoid,
            );
          yield* Effect.forkScoped(heartbeatLoop);
          return yield* run
            .run(input)
            .pipe(Effect.ensuring(lease.release().pipe(Effect.ignore)));
        },
      ).pipe(Effect.scoped);

      // The admitted slot, held live for the WHOLE post-gate window. The beat
      // fiber forks OUTSIDE `leased` on purpose: the lease-acquire wait can
      // itself last up to `LEASE_WAIT_TIMEOUT_MS` — exactly the admission TTL
      // — so a fiber forked only after `acquire` returns (the lease's own
      // heartbeat) would let the slot stale mid-wait, a peer's claim COUNT
      // would stop seeing it, and the pool would overcommit by the runs stuck
      // in that window. Same cadence + swallow-errors shape as the lease beat.
      const admissionHeld: Effect.Effect<unknown, RunError, RunContext> =
        Effect.gen(function* () {
          const admissionBeat: Effect.Effect<void, never> = admissions
            .heartbeat(payload.executionId)
            .pipe(
              Effect.ignore,
              Effect.repeat(
                Schedule.spaced(Duration.millis(LEASE_HEARTBEAT_EVERY_MS)),
              ),
              Effect.asVoid,
            );
          yield* Effect.forkScoped(admissionBeat);
          return yield* leased;
        }).pipe(Effect.scoped);

      // Admission gate FIRST, then the leased run body; the admission slot is
      // released on every exit path (success / run failure / AdmissionTimedOut
      // / defect / interrupt) — the release also opportunistically GCs stale
      // peer rows. An `AdmissionTimedOut` flows into `exit` as a normal
      // `failure`: recorded + reported through the same check-run path, with
      // failure-summary.ts rendering it unmistakably as an infra-wait timeout.
      const gated: Effect.Effect<unknown, RunError, RunContext> =
        admissionGate.pipe(
          Effect.andThen(admissionHeld),
          Effect.ensuring(
            admissions.release(payload.executionId).pipe(Effect.ignore),
          ),
        );
      const exit = yield* Effect.exit(gated);
      const completedAt = yield* Effect.sync(() => Date.now());

      const status = Exit.match(exit, {
        onSuccess: () => "success" as const,
        onFailure: () => "failure" as const,
      });

      // The run-authored failure presentation (issue #85): a typed failure may
      // carry markdown (`AcceptanceFailed.summaryMd` — e.g. `product-demo`'s
      // per-chapter table). Extracted ONCE here and reused by both the
      // check-run failure summary and the notify email below. `undefined` on
      // success, on a defect/interrupt, and on a summary-less failure — those
      // render the generic line alone, exactly as before.
      const failureMd = failureSummaryMd(exit);

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

      // --- Post-run writeback (the Worker proposes the diff as a PR) --------
      //
      // ONLY on a successful run that declares `writeback`: the container has
      // written a changed-files manifest + blobs to its artifact output
      // (`artifacts/<exec>/writeback/…` in R2); the WORKER — holding the App
      // installation token the container never sees — validates the manifest
      // against the run's declared `writeback` spec (path traversal, allowlist,
      // size cap, `.github/workflows/**` opt-in) and commits it via the Git
      // Data API (blob→tree→commit→ref→PR). Idempotent on the head branch.
      //
      // Best-effort, like the check-run + notify: a writeback failure is a
      // logged line on the (already-green) check-run summary, never a flip to
      // red — the run's own verdict stands; the proposed PR is a side output.
      // Runs in its own durable `step.do` so a Worker eviction mid-commit
      // replays the recorded outcome rather than re-committing.
      let writebackLine: string | undefined;
      if (run.writeback !== undefined && status === "success") {
        const spec = run.writeback;
        if (githubAppConfig === undefined) {
          writebackLine =
            "writeback skipped — GitHub App credentials not configured on this deploy";
        } else {
          const repo = payload.github.repo;
          const mintToken = makeWritebackTokenMinter(
            githubAppConfig,
            repo,
            payload.github.installation_id,
          );
          const outcome: WritebackOutcome = yield* Effect.tryPromise(() =>
            (
              step.do as unknown as (
                n: string,
                cb: () => Promise<WritebackOutcome>,
              ) => Promise<WritebackOutcome>
            )("writeback", () =>
              runWriteback({
                bucket,
                executionId: payload.executionId,
                spec,
                repo,
                dispatchRef: payload.github.ref,
                artifactName: WRITEBACK_ARTIFACT,
                mintToken,
              }),
            ),
          ).pipe(
            // A writeback failure (GitHub API error, missing creds mid-flight)
            // must never turn a green run red — log it and surface a line.
            Effect.catchAllCause((cause) =>
              Effect.logError(`writeback failed — ${cause}`).pipe(
                Effect.as<WritebackOutcome>({
                  kind: "rejected",
                  reasons: ["writeback errored — see Worker logs"],
                }),
              ),
            ),
          );
          writebackLine = describeOutcome(outcome);
          yield* Effect.logInfo(`writeback: ${writebackLine}`);
        }
      }

      // Complete the check-run with the run's verdict.
      const logsSuffix =
        detailsUrl !== undefined
          ? ` — [view step logs in Cloudflare ↗](${detailsUrl})`
          : "";
      const writebackSuffix =
        writebackLine !== undefined ? `\n\n${writebackLine}` : "";
      yield* checks.update({
        repo: payload.github.repo,
        checkRunId,
        conclusion: status,
        ...(detailsUrl !== undefined ? { detailsUrl } : {}),
        output: {
          title: checkRunName,
          summary: Exit.match(exit, {
            onSuccess: () =>
              `✓ ${payload.run} — execution succeeded.${logsSuffix}${writebackSuffix}`,
            // The run's own markdown (when the failure carries one) renders
            // beneath the generic line + logs link, truncated to GitHub's
            // 65535-char summary limit.
            onFailure: () =>
              appendFailureSummary(
                `✗ ${payload.run} — execution failed.${logsSuffix}`,
                failureMd,
              ),
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
          // The same run-authored markdown the check-run embeds — rendered
          // (escaped) on the email's failure branch.
          ...(failureMd !== undefined ? { failureDisplay: failureMd } : {}),
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
