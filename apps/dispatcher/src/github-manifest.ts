// FlareDispatch Dispatcher — GitHub App manifest builder.
//
// Returns the JSON object the manifest-exchange flow POSTs to
// `https://github.com/.../settings/apps/new` (specs/05-byoc.md § GitHub App
// setup). URLs are populated from `baseUrl` at request time — the Worker
// learns its own URL from the inbound `request.url`, so the same deploy works
// across `workers.dev` previews, custom domains, and local `wrangler dev`
// without any config.
//
// The companion `infra/github-app-manifest.json` exists as a human-readable
// copy (linked from the README and specs/05-byoc.md). The TS module is the
// only artifact the Worker actually reads; `github-manifest.test.ts` asserts
// the two stay in lockstep against `baseUrl = "https://runs.example.com"` so
// editing one without the other fails CI.
//
// --- Shape note --------------------------------------------------------------
//
// GitHub's "Create a GitHub App from a manifest" surface
// (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
// accepts: `name`, `url`, `hook_attributes`, `redirect_url`, `public`,
// `default_permissions`, `default_events`, and a few others we don't need.
// Permissions values are `"read" | "write" | "none"`; events is a list of
// webhook event names. Keeping the type narrow here surfaces drift at the
// `github-manifest.test.ts` lock-step assertion.

export interface GitHubAppManifest {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string };
  readonly redirect_url: string;
  readonly public: boolean;
  readonly default_permissions: Readonly<Record<string, "read" | "write">>;
  readonly default_events: readonly string[];
}

/**
 * Build the manifest for the given Dispatcher base URL (e.g.
 * `https://flare-dispatch-v0.acme.workers.dev`, no trailing slash).
 */
export const buildManifest = (baseUrl: string): GitHubAppManifest => {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    name: "FlareDispatch",
    description: "BYOC CI offload running on Cloudflare",
    url: base,
    hook_attributes: { url: `${base}/v1/webhooks/github` },
    redirect_url: `${base}/v1/github/installed`,
    public: false,
    default_permissions: {
      checks: "write",
      contents: "read",
      deployments: "read",
      metadata: "read",
      pull_requests: "read",
    },
    default_events: [
      "check_run",
      "check_suite",
      "deployment_status",
      "pull_request",
    ],
  };
};

/**
 * Compute the dispatcher's own canonical base URL from an inbound `Request`.
 * Strips the path/query and any trailing slash — the manifest's URLs are
 * built relative to the *origin*, not whatever path triggered the build.
 */
export const baseUrlFromRequest = (request: Request): string => {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
};
