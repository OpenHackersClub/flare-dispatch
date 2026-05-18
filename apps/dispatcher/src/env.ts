// FlareDispatch Dispatcher — typed binding environment.
//
// One field per binding declared in wrangler.jsonc. V0 surface only:
// Workflow + R2 + D1 + Container. Queue / DO / Browser bindings are deferred
// to V1+ and intentionally absent here.

export interface Env {
  /** Workflow binding — instantiates RunWorkflow executions. */
  readonly RUNS_WORKFLOW: Workflow;

  /** Container binding — one sandbox instance per execution. */
  readonly RUNS_SANDBOX: DurableObjectNamespace;

  /** R2 bucket — `logs/<execution-id>/<step>.ndjson`. */
  readonly RUNS_STORAGE: R2Bucket;

  /** D1 database — `executions` + `steps` metadata tables. */
  readonly RUNS_METADATA: D1Database;
}
