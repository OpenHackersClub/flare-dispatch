// FlareDispatch Dispatcher — `GET /v1/github/installed?code=<code>&state=<state>`.
//
// Callback for the "Create a GitHub App from a manifest" flow (specs/05-byoc.md
// § GitHub App setup). The browser arrives here after GitHub created the App;
// we verify the `state` token we issued in `/v1/github/start`, then exchange
// `code` for the App's credentials via
// `POST https://api.github.com/app-manifests/{code}/conversions`. The code is
// single-use and expires after one hour.
//
// The response renders the credentials as HTML with pre-built
// `wrangler secret put` snippets so the operator can paste them into a
// terminal in seconds. The page is marked `Cache-Control: no-store` +
// `Referrer-Policy: no-referrer` so the PEM doesn't end up in browser caches
// or leak via referer.
//
// --- Why HTML and not JSON ---------------------------------------------------
//
// JSON would force every operator to wire up `jq` (or eyeball escaped \n's in
// the PEM). HTML lets us render the PEM inside a <pre> verbatim and offer
// per-field copy buttons. JSON output for scripted callers can come later;
// for V0 the manifest exchange is a human flow.

import type { Env } from "../env";
import { verifyState, type StateVerifyResult } from "../github-state";

/**
 * Shape of the credentials GitHub returns from
 * `POST /app-manifests/{code}/conversions`. We pull only what the operator
 * needs to set as Worker secrets — `id`, `webhook_secret`, `pem`. The full
 * response carries more fields (`slug`, `html_url`, `client_id`, etc.) we
 * pass through to the page only for context.
 */
interface ManifestConversionResponse {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly html_url: string;
  readonly pem: string;
  readonly webhook_secret: string;
  readonly owner?: { readonly login?: string };
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const errorPage = (status: number, summary: string, detail: string): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>FlareDispatch — error</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1f2328;}h1{color:#cf222e;}pre{background:#f6f8fa;padding:1rem;border-radius:6px;overflow-x:auto;font-size:0.85rem;}</style>
</head><body><h1>${escapeHtml(summary)}</h1><pre>${escapeHtml(detail)}</pre></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

/** Human-readable label for a state verify failure. */
const stateFailureLabel = (
  result: Extract<StateVerifyResult, { ok: false }>,
): string => {
  switch (result.reason) {
    case "expired":
      return "The signed `state` token expired (5-minute TTL). Restart from `/v1/github/start`.";
    case "bad_mac":
    case "bad_version":
    case "malformed":
      return "The signed `state` token did not verify against this Dispatcher's `HMAC_SECRET`. Either the redirect came from a different Dispatcher, or the secret was rotated mid-flow.";
  }
};

/**
 * Handle `GET /v1/github/installed`. `now` and `fetchImpl` are parameters so
 * tests can pin time and stub the GitHub API call — the router calls without
 * them and they default to live behavior.
 */
export const handleGithubInstalled = async (
  request: Request,
  env: Env,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return errorPage(
      400,
      "Missing `code` or `state`",
      `Expected both query params on the GitHub manifest-exchange callback.
Got code=${code ?? "<missing>"}, state=${state ? "<present>" : "<missing>"}.`,
    );
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const stateResult = await verifyState(env.HMAC_SECRET, state, now);
  if (!stateResult.ok) {
    return errorPage(
      400,
      "state did not verify",
      stateFailureLabel(stateResult),
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const exchangeUrl = `https://api.github.com/app-manifests/${encodeURIComponent(
    code,
  )}/conversions`;
  const resp = await fetchImpl(exchangeUrl, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "flare-dispatch-dispatcher",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return errorPage(
      resp.status,
      `GitHub exchange failed (HTTP ${resp.status})`,
      `POST ${exchangeUrl}\n\n${detail}`,
    );
  }

  const creds = (await resp.json()) as ManifestConversionResponse;
  return renderSuccess(creds);
};

/**
 * Render the credentials page. The page intentionally exposes the values in
 * plain text inside `<pre>` blocks so the operator can copy them — they were
 * just generated by GitHub specifically for this exchange.
 */
const renderSuccess = (creds: ManifestConversionResponse): Response => {
  const installUrl = creds.html_url
    ? `${creds.html_url.replace(/\/$/, "")}/installations/new`
    : "";
  const owner = creds.owner?.login ?? "<your account>";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlareDispatch — App created</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1.25rem; color: #1f2328; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  code { background: #eff1f3; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.92em; }
  pre { background: #f6f8fa; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
  pre.pem { white-space: pre; word-break: normal; }
  .warn { background: #fff8c5; border-left: 4px solid #d4a72c; padding: 0.75rem 1rem; border-radius: 4px; }
  .ok { color: #1a7f37; }
  a { color: #0969da; }
</style>
</head>
<body>
<h1 class="ok">✓ App created: ${escapeHtml(creds.name)}</h1>
<p>Owner: <code>${escapeHtml(owner)}</code> &middot; App ID: <code>${creds.id}</code> &middot; <a href="${escapeHtml(creds.html_url)}" target="_blank" rel="noopener noreferrer">Manage on GitHub →</a></p>

<div class="warn">
<strong>This page won't load twice.</strong> GitHub's manifest-exchange code is single-use. Copy the values below into Worker secrets <em>now</em>; if you navigate away, you'll need to regenerate the private key from the App's settings page (the App ID and webhook secret are still visible there, but the PEM is one-shot).
</div>

<h2>1. Set the Worker secrets</h2>
<p>Run these from the Dispatcher repo. Pipe the PEM from a file so the newlines survive:</p>
<pre>echo '${escapeHtml(String(creds.id))}' | wrangler secret put GITHUB_APP_ID
echo '${escapeHtml(creds.webhook_secret)}' | wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY &lt; ./flaredispatch.private-key.pem
rm ./flaredispatch.private-key.pem</pre>

<h2>2. Private key (PEM)</h2>
<p>Save the block below to <code>./flaredispatch.private-key.pem</code> before running the <code>wrangler secret put GITHUB_APP_PRIVATE_KEY</code> command above. <strong>Delete the file as soon as the secret is uploaded.</strong></p>
<pre class="pem">${escapeHtml(creds.pem)}</pre>

<h2>3. Install the App</h2>
<p>The App is created but not yet installed on any repos. ${
    installUrl
      ? `<a href="${escapeHtml(installUrl)}" target="_blank" rel="noopener noreferrer">Click here to choose where to install it →</a>`
      : `Visit the App's settings page on GitHub and click "Install App".`
  }</p>

<h2>4. Verify</h2>
<pre>curl -fsS https://&lt;your-dispatcher&gt;/health
# { "status": "ok", "runs": [...] }</pre>
<p>After the first webhook delivery the Dispatcher learns the installation id automatically — no further config needed.</p>
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
