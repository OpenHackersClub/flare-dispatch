// Unit tests for github-manifest.ts.
//
// The load-bearing test is `lockstep with infra/github-app-manifest.json`:
// the JSON file is the human-readable copy linked from the README + specs, the
// TS module is what the Worker actually serves to GitHub. If either ever
// drifts from the other without a deliberate sync, this test fails.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseUrlFromRequest, buildManifest } from "./github-manifest";

const REPO_MANIFEST_PATH = fileURLToPath(
  new URL("../../../infra/github-app-manifest.json", import.meta.url),
);

describe("github-manifest", () => {
  it("lockstep with infra/github-app-manifest.json (baseUrl = runs.example.com)", () => {
    const onDisk = JSON.parse(readFileSync(REPO_MANIFEST_PATH, "utf8"));
    const built = buildManifest("https://runs.example.com");
    expect(built).toEqual(onDisk);
  });

  it("substitutes baseUrl into hook_attributes + redirect_url + url", () => {
    const m = buildManifest("https://flare-dispatch-v0.acme.workers.dev");
    expect(m.url).toBe("https://flare-dispatch-v0.acme.workers.dev");
    expect(m.hook_attributes.url).toBe(
      "https://flare-dispatch-v0.acme.workers.dev/v1/webhooks/github",
    );
    expect(m.redirect_url).toBe(
      "https://flare-dispatch-v0.acme.workers.dev/v1/github/installed",
    );
  });

  it("strips a trailing slash from baseUrl so paths don't double-up", () => {
    const m = buildManifest("https://example.com/");
    expect(m.url).toBe("https://example.com");
    expect(m.redirect_url).toBe("https://example.com/v1/github/installed");
  });

  it("pins permissions to checks:write + read on contents/deployments/metadata/pull_requests", () => {
    const m = buildManifest("https://x");
    expect(m.default_permissions).toEqual({
      checks: "write",
      contents: "read",
      deployments: "read",
      metadata: "read",
      pull_requests: "read",
    });
  });

  it("subscribes to check_run, check_suite, deployment_status, pull_request", () => {
    expect(buildManifest("https://x").default_events).toEqual([
      "check_run",
      "check_suite",
      "deployment_status",
      "pull_request",
    ]);
  });

  it("is private (public: false) — BYOC default, not Marketplace-listed", () => {
    expect(buildManifest("https://x").public).toBe(false);
  });

  describe("baseUrlFromRequest", () => {
    it("strips path + query, keeps protocol + host", () => {
      const req = new Request(
        "https://flare-dispatch-v0.acme.workers.dev/v1/github/start?org=OHC",
      );
      expect(baseUrlFromRequest(req)).toBe(
        "https://flare-dispatch-v0.acme.workers.dev",
      );
    });

    it("keeps an explicit non-standard port", () => {
      const req = new Request("http://localhost:8787/v1/github/start");
      expect(baseUrlFromRequest(req)).toBe("http://localhost:8787");
    });
  });
});
