import { describe, expect, it } from "vitest";
import { WORKFLOWS_DASHBOARD_NAME, workflowDashboardUrl } from "./dashboard-url";

describe("workflowDashboardUrl", () => {
  it("builds the Workflows instance deep-link when an account id is set", () => {
    expect(workflowDashboardUrl("acct123", "01HXYZ")).toBe(
      `https://dash.cloudflare.com/acct123/workers/workflows/${WORKFLOWS_DASHBOARD_NAME}/instance/01HXYZ`,
    );
  });

  it("returns undefined (BYOC default) when the account id is unset or empty", () => {
    expect(workflowDashboardUrl(undefined, "01HXYZ")).toBeUndefined();
    expect(workflowDashboardUrl("", "01HXYZ")).toBeUndefined();
  });

  it("URL-encodes the executionId so a `/` or space can't escape the path", () => {
    expect(workflowDashboardUrl("acct123", "a/b c")).toBe(
      `https://dash.cloudflare.com/acct123/workers/workflows/${WORKFLOWS_DASHBOARD_NAME}/instance/a%2Fb%20c`,
    );
  });
});
