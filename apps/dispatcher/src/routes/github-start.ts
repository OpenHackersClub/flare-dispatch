// FlareDispatch Dispatcher — `GET /v1/github/start[?org=<slug>]`.
//
// Renders an HTML form that POSTs the FlareDispatch App manifest to GitHub's
// "Create a GitHub App from a manifest" surface (specs/05-byoc.md § GitHub
// App setup):
//
//   - org=<slug> present  →  https://github.com/organizations/<slug>/settings/apps/new
//   - org absent          →  https://github.com/settings/apps/new (personal account)
//
// The form action carries a signed `state` token (github-state.ts) so the
// matching `GET /v1/github/installed` callback can confirm it issued this
// exchange. The page does NOT auto-submit — the operator clicks "Continue"
// once they've seen the manifest preview, which is the only chance they have
// to verify they're about to install on the right account.
//
// Why HTML (not a redirect to a pre-built GitHub URL): GitHub's "create from
// manifest" endpoint reads the manifest from a form-encoded body, so we MUST
// POST. A GET-only redirect doesn't carry that payload.

import type { Env } from "../env";
import { baseUrlFromRequest, buildManifest } from "../github-manifest";
import { signState } from "../github-state";

/** GitHub org slug — same charset GitHub itself allows. */
const ORG_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Handle `GET /v1/github/start`. `now` and `nonce` are parameters so tests can
 * pin them — the router calls without them and they default to the live clock
 * + a fresh CSPRNG nonce.
 */
export const handleGithubStart = async (
  request: Request,
  env: Env,
  opts: { now?: number; nonce?: string } = {},
): Promise<Response> => {
  const url = new URL(request.url);
  const org = url.searchParams.get("org") ?? "";

  if (org && !ORG_SLUG.test(org)) {
    return new Response(
      JSON.stringify({
        error: "invalid_org",
        message: "org must match the GitHub org slug format",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const state = await signState(env.HMAC_SECRET, now, opts.nonce);

  const baseUrl = baseUrlFromRequest(request);
  const manifest = buildManifest(baseUrl);
  const manifestJson = JSON.stringify(manifest);

  const submitUrl = org
    ? `https://github.com/organizations/${encodeURIComponent(
        org,
      )}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;

  const orgLine = org
    ? `to organization <code>${escapeHtml(org)}</code>`
    : `to your personal account`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlareDispatch — create GitHub App</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; color: #1f2328; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { margin: 0.75rem 0; }
  code { background: #eff1f3; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.92em; }
  details { margin: 1.5rem 0; }
  summary { cursor: pointer; color: #0969da; }
  pre { background: #f6f8fa; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; line-height: 1.4; }
  button { font-size: 1rem; padding: 0.65rem 1.4rem; border-radius: 6px; border: 0; background: #1f883d; color: white; cursor: pointer; font-weight: 600; }
  button:hover { background: #1a7f37; }
  .note { color: #59636e; font-size: 0.88rem; }
</style>
</head>
<body>
<h1>Create the FlareDispatch GitHub App</h1>
<p>This will submit the manifest below to GitHub ${orgLine}. GitHub creates the App, then redirects back here with the credentials.</p>
<details>
  <summary>Review the manifest being submitted</summary>
  <pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
</details>
<form method="POST" action="${escapeHtml(submitUrl)}">
  <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
  <p><button type="submit">Continue to GitHub →</button></p>
</form>
<p class="note">The signed <code>state</code> in the form action expires in 5 minutes. If the redirect back here fails, reload this page to mint a fresh one.</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
};
