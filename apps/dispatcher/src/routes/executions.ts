// FlareDispatch Dispatcher — `GET /v1/executions` and `GET /v1/executions/:id`.
//
// The JSON inspection surface specs/01-architecture.md marks "Inspection —
// Planned (V1)" and specs/04-gha-integration.md's await-mode poller reads:
//
//   GET /v1/executions       — list executions (filterable). ENUMERATES repos
//                              and activity, so it is ADMIN_TOKEN-gated (same
//                              bearer pattern as routes/admin-events.ts). The
//                              HTML viewer never calls it, so no bearer ever
//                              reaches a browser.
//   GET /v1/executions/:id   — one execution + its steps + its R2 log-file
//                              index + its artifacts. Per-execution → gated by
//                              the capability token (log-auth.ts), NOT the
//                              bearer. `input_json` is omitted (caller payloads
//                              may be private — review m3); `summary_json` is
//                              included.
//
// The R2 `list({prefix:"logs/<id>/"})` is the source of truth for which exec
// logs exist (the unused `steps.log_uri` column stays reserved) — review M1.

import type { Env } from "../env";
import {
  getExecution,
  getSteps,
  listExecutions,
  type ExecutionRow,
  type StepRow,
} from "../executions-read";
import { gateLogAccess } from "../log-auth";
import {
  buildLogsUrl,
  resolveLogLinkSecret,
  signLogToken,
} from "../log-token";
import { workflowDashboardUrl } from "../dashboard-url";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Constant-time-ish comparison for equal-length strings (admin bearer). */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Default + max page size for the listing. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Public-facing camelCase view of an execution row (no `input_json`). */
const executionView = (
  row: ExecutionRow,
  links: { logsUrl?: string; dashboardUrl?: string },
) => ({
  id: row.id,
  run: row.run,
  repo: row.repo,
  ref: row.ref,
  sha: row.sha,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  ...(row.parent_execution_id !== null
    ? { parentExecutionId: row.parent_execution_id }
    : {}),
  ...(row.check_run_id !== null ? { checkRunId: row.check_run_id } : {}),
  ...(links.logsUrl !== undefined ? { logsUrl: links.logsUrl } : {}),
  ...(links.dashboardUrl !== undefined
    ? { dashboardUrl: links.dashboardUrl }
    : {}),
});

const stepView = (row: StepRow) => ({
  name: row.name,
  status: row.status,
  attempt: row.attempt,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
});

/**
 * `GET /v1/executions` — ADMIN_TOKEN-gated listing. Query params: `run`,
 * `repo`, `status`, `limit` (≤200), `before` (ms-epoch keyset cursor).
 */
export const handleExecutionsList = async (
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> => {
  if (env.ADMIN_TOKEN === undefined) {
    return json(
      {
        error: "admin_not_configured",
        message: "ADMIN_TOKEN is unset; the executions listing is off",
      },
      503,
    );
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) {
    return json(
      { error: "unauthorized", message: "Authorization bearer missing or invalid" },
      401,
    );
  }

  const q = url.searchParams;
  const rawLimit = Number.parseInt(q.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const rawBefore = Number.parseInt(q.get("before") ?? "", 10);
  const filters = {
    ...(q.get("run") !== null ? { run: q.get("run")! } : {}),
    ...(q.get("repo") !== null ? { repo: q.get("repo")! } : {}),
    ...(q.get("status") !== null ? { status: q.get("status")! } : {}),
    ...(Number.isFinite(rawBefore) ? { before: rawBefore } : {}),
    limit,
  };

  const rows = await listExecutions(env.RUNS_METADATA, filters);
  const secret = resolveLogLinkSecret(env);
  const origin = env.PUBLIC_ORIGIN ?? url.origin;

  const executions = await Promise.all(
    rows.map(async (row) => {
      const dashboardUrl = workflowDashboardUrl(
        env.CLOUDFLARE_ACCOUNT_ID,
        row.id,
      );
      const logsUrl =
        secret !== undefined
          ? buildLogsUrl(origin, row.id, await signLogToken(secret, row.id))
          : undefined;
      return executionView(row, {
        ...(logsUrl !== undefined ? { logsUrl } : {}),
        ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
      });
    }),
  );

  // Keyset cursor for the next page: the oldest `started_at` returned.
  const last = rows[rows.length - 1];
  const nextBefore =
    rows.length === limit && last?.started_at != null ? last.started_at : null;

  return json({ executions, nextBefore }, 200);
};

/**
 * `GET /v1/executions/:id` — capability-token-gated detail. Returns the
 * execution (no `input_json`), its steps, its R2 log files, and its artifacts.
 */
export const handleExecutionDetail = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  const row = await getExecution(env.RUNS_METADATA, executionId);
  if (row === null) {
    return json(
      { error: "execution_not_found", message: `no execution "${executionId}"` },
      404,
    );
  }

  const secret = resolveLogLinkSecret(env);
  const origin = env.PUBLIC_ORIGIN ?? url.origin;
  // Re-derive THIS execution's token to self-link the log files (the caller
  // already proved possession of it via the gate).
  const token =
    secret !== undefined ? await signLogToken(secret, executionId) : "";

  const [steps, logList, artifactList] = await Promise.all([
    getSteps(env.RUNS_METADATA, executionId),
    env.RUNS_STORAGE.list({ prefix: `logs/${executionId}/`, limit: 1000 }),
    env.RUNS_STORAGE.list({ prefix: `artifacts/${executionId}/`, limit: 1000 }),
  ]);

  const logs = logList.objects.map((o) => {
    const file = o.key.slice(`logs/${executionId}/`.length);
    return {
      file,
      size: o.size,
      url: `/v1/executions/${encodeURIComponent(
        executionId,
      )}/logs/${encodeURIComponent(file)}?t=${token}`,
    };
  });

  // Top-level artifact objects only (skip the upload-time browse expansion
  // keys nested under `<name>/…`).
  const artifactPrefix = `artifacts/${executionId}/`;
  const artifacts = artifactList.objects
    .map((o) => o.key.slice(artifactPrefix.length))
    .filter((rel) => rel.length > 0 && !rel.includes("/"))
    .map((name) => ({
      name,
      url: `/v1/artifacts/${encodeURIComponent(executionId)}/${encodeURIComponent(name)}`,
    }));

  const dashboardUrl = workflowDashboardUrl(env.CLOUDFLARE_ACCOUNT_ID, row.id);
  const logsUrl =
    secret !== undefined ? buildLogsUrl(origin, row.id, token) : undefined;

  return json(
    {
      execution: executionView(row, {
        ...(logsUrl !== undefined ? { logsUrl } : {}),
        ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
      }),
      ...(row.summary_json !== null
        ? { summary: safeParse(row.summary_json) }
        : {}),
      steps: steps.map(stepView),
      logs,
      artifacts,
    },
    200,
  );
};

/** Parse stored JSON, falling back to the raw string if it is not valid JSON. */
const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
