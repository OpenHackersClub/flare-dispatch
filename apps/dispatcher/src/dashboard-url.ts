// The Cloudflare dashboard deep-link for a Workflow execution's instance page.
//
// Extracted so BOTH the Workflow entrypoint (which uses it for the GitHub
// check-run's `details_url`) and the dispatch route (which now returns it in
// the 202 so the caller — the GHA Action — can surface it immediately, on
// success AND failure) share one definition.

/** The Workflow's dashboard name segment — `RUNS_WORKFLOW` in wrangler config. */
export const WORKFLOWS_DASHBOARD_NAME = "runs-workflow";

/**
 * Build the Cloudflare dashboard deep-link for this execution's Workflow
 * instance (the `executionId` doubles as the CF Workflow `instanceId` —
 * `RUNS_WORKFLOW.create({ id: executionId })`), or `undefined` when the
 * account id is not configured (the BYOC default — consumers render exactly
 * as before, with no link).
 */
export const workflowDashboardUrl = (
  accountId: string | undefined,
  executionId: string,
): string | undefined =>
  accountId !== undefined && accountId.length > 0
    ? `https://dash.cloudflare.com/${accountId}/workers/workflows/${WORKFLOWS_DASHBOARD_NAME}/instance/${encodeURIComponent(executionId)}`
    : undefined;
