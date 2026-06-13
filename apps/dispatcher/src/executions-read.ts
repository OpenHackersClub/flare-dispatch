// FlareDispatch Dispatcher — read-side D1 queries for the log/executions routes.
//
// The WRITE side of `executions` / `steps` lives in
// `@flare-dispatch/runtime-cf` (executions-d1.ts), wired into the Workflow's
// runtime. The READ side belongs to the dispatcher's HTTP surface and is kept
// here — plain functions over the `D1Database` binding (a `@cloudflare/
// workers-types` TYPE, not a `cloudflare:workers` runtime import), so the route
// modules that call them stay testable under plain Node + Vitest 2, exactly
// like routes/artifacts.ts reads `RUNS_STORAGE` directly.
//
// Schema: infra/migrations/0001_initial_schema.sql.

/** One row of the `executions` table, as stored (snake_case columns). */
export type ExecutionRow = {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly parent_execution_id: string | null;
  readonly input_json: string;
  readonly summary_json: string | null;
  readonly check_run_id: number | null;
};

/** One row of the `steps` table. */
export type StepRow = {
  readonly id: string;
  readonly execution_id: string;
  readonly name: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly exit_code: number | null;
  readonly log_uri: string | null;
  readonly attempt: number;
};

/** Terminal execution statuses — logs are immutable once one is reached. */
const TERMINAL = new Set(["success", "failure", "cancelled"]);

/** True iff `status` is a terminal execution state (safe to cache logs hard). */
export const isTerminal = (status: string | undefined): boolean =>
  status !== undefined && TERMINAL.has(status);

/** Filters + paging for `listExecutions`. */
export type ListFilters = {
  readonly run?: string;
  readonly repo?: string;
  readonly status?: string;
  /** Page size, already clamped by the caller. */
  readonly limit: number;
  /** Keyset cursor: only rows with `started_at < before`. */
  readonly before?: number;
};

/**
 * List executions newest-first, with optional `run`/`repo`/`status` filters and
 * a `started_at` keyset cursor. Returns at most `limit` rows.
 */
export const listExecutions = async (
  db: D1Database,
  filters: ListFilters,
): Promise<ExecutionRow[]> => {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filters.run !== undefined) {
    where.push("run = ?");
    binds.push(filters.run);
  }
  if (filters.repo !== undefined) {
    where.push("repo = ?");
    binds.push(filters.repo);
  }
  if (filters.status !== undefined) {
    where.push("status = ?");
    binds.push(filters.status);
  }
  if (filters.before !== undefined) {
    where.push("started_at < ?");
    binds.push(filters.before);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM executions ${whereSql}
               ORDER BY started_at DESC
               LIMIT ?`;
  binds.push(filters.limit);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ExecutionRow>();
  return results ?? [];
};

/** Fetch one execution by id, or `null` if there is no such row. */
export const getExecution = async (
  db: D1Database,
  id: string,
): Promise<ExecutionRow | null> =>
  db.prepare("SELECT * FROM executions WHERE id = ?").bind(id).first<ExecutionRow>();

/** Fetch an execution's steps, ordered by start time then name. */
export const getSteps = async (
  db: D1Database,
  executionId: string,
): Promise<StepRow[]> => {
  const { results } = await db
    .prepare(
      `SELECT * FROM steps WHERE execution_id = ?
       ORDER BY started_at ASC, name ASC`,
    )
    .bind(executionId)
    .all<StepRow>();
  return results ?? [];
};
