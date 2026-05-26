// FlareDispatch Dispatcher — GitHub App manifest creation routes.
//
// The two-leg flow that lets an operator create their FlareDispatch GitHub App
// without ever leaving the Dispatcher origin (specs/05-byoc.md § GitHub App
// setup):
//
//   GET /v1/github/install/new
//     Without `?owner` — renders a chooser asking whether the App should be
//     owned by the operator's personal account or by an org (text input for
//     the org login). The chooser submits back to the same path with the
//     `owner` query set.
//
//     With `?owner=` (empty) — renders a self-submitting `<form>` POST to
//     `https://github.com/settings/apps/new?state=<csrf>` (personal owner).
//
//     With `?owner=<org>` — same shape but POSTs to
//     `https://github.com/organizations/<org>/settings/apps/new?state=<csrf>`
//     so the resulting App is owned by `<org>`, not by the signed-in user.
//     Org-owned Apps survive a single admin leaving; personal-owned ones
//     don't. Validated server-side against the GitHub login grammar
//     (alphanumeric + single dashes, ≤39 chars); invalid → 400.
//
//     In every case the form carries the `manifest` JSON pulled from
//     `infra/github-app-manifest.json` with the placeholder `runs.example.com`
//     URLs rewritten to the current Dispatcher's own origin (derived from
//     `request.url`) — so the same code works on `*.workers.dev`, a custom
//     domain, and `wrangler dev`.
//
//   GET /v1/github/installed?code=<code>&state=<state>
//     GitHub's `redirect_url` callback. Exchanges `code` for the App's
//     credentials via `POST https://api.github.com/app-manifests/<code>/
//     conversions` (no auth — the code IS the credential, valid for one minute
//     after creation) and renders a one-shot "Success" page with the
//     `wrangler secret put` commands the operator must run NOW.
//
// --- Out of scope (deferred follow-up PRs) -----------------------------------
//
//   * `/v1/webhooks/github` — App event receiver + HMAC verify + KV install
//     map. The manifest declares the hook URL but no receiver is wired yet.
//   * Installation-token caching — `@flare-dispatch/github-app` already exists
//     but isn't called from the Worker on this PR.
//   * CSRF state-token *binding*. The form carries a `state` so the GitHub
//     redirect echoes it back, but we don't persist it to KV yet — single-PR
//     scope. A follow-up PR will bind state to `IDEMPOTENCY_KV` and reject
//     callbacks whose state we never minted.
//
// --- XSS posture -------------------------------------------------------------
//
// The "Success" page interpolates GitHub-controlled strings (`slug`, `name`,
// `html_url`, `pem`, …). The credentials shown belong to *their* App so
// there's no privilege escalation, but a hostile GitHub response could still
// land an XSS payload on the operator's browser. Every interpolated string is
// run through `htmlEscape` — never raw concatenation. The PEM block is
// rendered inside a `<pre>` with the same escape applied; line breaks are
// preserved by the surrounding `<pre>`.

import { Effect, Either, Match, Schema } from "effect";

/**
 * The manifest template ships in `infra/github-app-manifest.json` with three
 * placeholder URLs hardcoded as `runs.example.com`. The template is consumed
 * AT REQUEST TIME so the same deploy artifact serves every origin — we never
 * bake a specific Dispatcher URL into the JSON file.
 *
 * The literal is duplicated here (rather than `import`ed from `infra/`) so the
 * Worker bundle stays self-contained — Workers can't read files at runtime,
 * and a build-time `import` of JSON would require a wrangler module rule. The
 * test for `install/new` asserts the substitutions on this same object, and a
 * follow-up could enforce template-vs-shipped-JSON parity with a snapshot if
 * the file ever drifts from this copy.
 */
const MANIFEST_TEMPLATE = {
  name: "FlareDispatch",
  description: "BYOC CI offload running on Cloudflare",
  url: "https://runs.example.com",
  hook_attributes: {
    url: "https://runs.example.com/v1/webhooks/github",
  },
  redirect_url: "https://runs.example.com/v1/github/installed",
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
} as const;

/** The placeholder origin every URL in the template starts with. */
const TEMPLATE_PLACEHOLDER = "https://runs.example.com";

/**
 * Resolve the template against the inbound request's own origin so the
 * resulting manifest's `url`, `hook_attributes.url`, and `redirect_url` all
 * point back at THIS Dispatcher. We accept a structurally-typed JSON object so
 * tests can swap in a mock template if needed.
 */
const resolveManifest = (origin: string): Record<string, unknown> => {
  // Deep-clone via JSON round-trip — the template is small and frozen-shape,
  // so the cost is negligible and we avoid hand-rolling a recursive copy.
  const m = JSON.parse(JSON.stringify(MANIFEST_TEMPLATE)) as {
    url: string;
    hook_attributes: { url: string };
    redirect_url: string;
    [k: string]: unknown;
  };
  m.url = m.url.replace(TEMPLATE_PLACEHOLDER, origin);
  m.hook_attributes.url = m.hook_attributes.url.replace(
    TEMPLATE_PLACEHOLDER,
    origin,
  );
  m.redirect_url = m.redirect_url.replace(TEMPLATE_PLACEHOLDER, origin);
  return m;
};

/**
 * HTML-escape every metacharacter that could break out of a text node or an
 * attribute value. The output is safe for both contexts. We do NOT use the
 * named `&apos;` entity — it isn't defined in HTML4 and not all renderers
 * handle it; numeric `&#39;` is universal.
 */
export const htmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A `text/html; charset=utf-8` response. */
const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** A `application/json` error response — used for trivial 4xx paths. */
const jsonError = (
  error: string,
  message: string,
  status: number,
): Response =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * GitHub login grammar: a leading alphanumeric followed by ≤38 alphanumerics
 * or single dashes. Real GitHub also forbids consecutive dashes and a trailing
 * dash, but those finer rules are GitHub's to enforce — a too-strict regex
 * here would refuse logins the user could legitimately create. The intent of
 * this check is to make sure the value is safe to splat into a URL path and
 * an HTML attribute, not to perfectly mirror GitHub's reserved-name list.
 */
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * Build the form action URL for a given owner choice.
 *   - `""`        → personal-account App   → `/settings/apps/new`
 *   - `"<org>"`   → org-owned App          → `/organizations/<org>/settings/apps/new`
 *
 * `org` is `encodeURIComponent`'d defensively, even though the validator
 * already restricts the input to URL-safe characters — same belt-and-braces
 * rule as `dispatch.ts`'s `encodeURIComponent(run)`.
 */
const formActionForOwner = (owner: string, state: string): string => {
  const safeState = encodeURIComponent(state);
  if (owner === "") {
    return `https://github.com/settings/apps/new?state=${safeState}`;
  }
  return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${safeState}`;
};

/**
 * The owner-chooser page — rendered when `/install/new` is hit without an
 * `owner` query param. Two GET-submit forms route the operator back to
 * `/install/new?owner=` (personal) or `/install/new?owner=<input>` (org).
 *
 * The org form uses a `pattern` attribute as a client-side hint; the
 * server-side validator in `handleInstallNew` is the real enforcement.
 */
const renderOwnerChooser = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlareDispatch — Choose App owner</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
    input[type="text"] { font: inherit; padding: 0.4rem 0.6rem; min-width: 16rem; }
    code { font-family: ui-monospace, Menlo, monospace; }
    .option { border: 1px solid #d4d4d8; border-radius: 6px; padding: 1rem 1.25rem; margin: 1rem 0; }
    .option h2 { margin-top: 0; }
    .hint { color: #555; font-size: 0.9rem; }
    label { display: block; margin-bottom: 0.4rem; }
  </style>
</head>
<body>
  <h1>Create your FlareDispatch GitHub App</h1>
  <p>FlareDispatch is BYOC — there is no shared App. This step creates an App in your GitHub account or org and hands the private key back to this Dispatcher (one-time, stored in your Worker Secrets).</p>

  <h2>Pick an owner</h2>
  <p class="hint">App ownership controls who can manage the App and rotate its key. Org-owned Apps survive a single admin leaving; personal-owned ones don&#39;t.</p>

  <form class="option" method="get" action="/v1/github/install/new">
    <h2>Personal account</h2>
    <p class="hint">Owned by whoever is signed in to GitHub when you continue. Fine for solo use; brittle for teams.</p>
    <input type="hidden" name="owner" value="">
    <button type="submit">Continue as personal account</button>
  </form>

  <form class="option" method="get" action="/v1/github/install/new">
    <h2>Organization</h2>
    <p class="hint">Recommended for teams. You must have <em>Owner</em> role on the org. The App will be created under the org and all org admins can manage it afterward.</p>
    <label for="owner-input">Organization login (the <code>&lt;org&gt;</code> in <code>github.com/&lt;org&gt;</code>):</label>
    <input type="text" id="owner-input" name="owner" placeholder="acme-corp" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}" maxlength="39" required>
    <button type="submit" style="margin-left: 0.5rem">Continue as organization</button>
  </form>
</body>
</html>`;

/**
 * The manifest-form page. Auto-submits via JS on load; a `<noscript>` button
 * gives a manual fallback for headless browsers and JS-disabled UAs.
 *
 * GitHub's docs spell the receiving endpoint as `settings/apps/new` (personal)
 * or `organizations/<org>/settings/apps/new` (org-owned) — `formActionForOwner`
 * picks the right one. The `?state=<csrf>` query is what GitHub echoes back to
 * `redirect_url` so we can (in a follow-up PR) verify the callback wasn't
 * initiated by a third party.
 */
const renderInstallForm = (
  manifest: Record<string, unknown>,
  state: string,
  owner: string,
): string => {
  const manifestJson = JSON.stringify(manifest);
  // The hidden `manifest` input value is HTML-attribute-escaped — `htmlEscape`
  // turns `"` into `&quot;` so the `value="..."` boundary holds. The state is
  // a UUID, so escaping is overkill, but apply it as defense-in-depth.
  const safeManifest = htmlEscape(manifestJson);
  const safeState = htmlEscape(state);
  // `formActionForOwner` already URL-encodes the org segment; we additionally
  // HTML-escape the resulting attribute value for the `<form action="…">`
  // boundary. Belt-and-braces — the regex validator already excludes any HTML
  // metacharacter.
  const actionUrl = htmlEscape(formActionForOwner(owner, state));
  const ownerLabel =
    owner === ""
      ? "your personal account"
      : `<code>${htmlEscape(owner)}</code>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlareDispatch — Create GitHub App</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
    code { font-family: ui-monospace, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>FlareDispatch — Create GitHub App</h1>
  <p>Redirecting you to GitHub to create the FlareDispatch App, owned by ${ownerLabel}. If you aren&#39;t redirected automatically, click the button below.</p>
  <form id="manifest-form" method="post" action="${actionUrl}">
    <input type="hidden" name="manifest" value="${safeManifest}">
    <input type="hidden" name="state" value="${safeState}">
    <noscript>
      <p><button type="submit">Continue to GitHub</button></p>
    </noscript>
  </form>
  <script>
    // Auto-submit so the page is effectively a redirect with a body.
    document.getElementById('manifest-form').submit();
  </script>
</body>
</html>`;
};

/**
 * Handle `GET /v1/github/install/new` — render either the owner chooser or
 * the manifest-form page, depending on whether `owner` was supplied.
 *
 *   - no `owner` query                  → chooser (200 HTML)
 *   - `owner=` (empty)                  → personal-account form (200 HTML)
 *   - `owner=<valid-login>`             → org-owned form (200 HTML)
 *   - `owner=<invalid>`                 → 400 JSON
 *
 * The "empty `owner` means personal" sentinel is intentional — `null` (no
 * query at all) is the "user hasn't chosen yet" case, while an explicit empty
 * string means "I chose personal." This matches the chooser's two forms:
 * both POST `owner`, one with a value, one without.
 *
 * The form's `manifest` is a fresh resolution of `MANIFEST_TEMPLATE` against
 * `new URL(request.url).origin`. We use `crypto.randomUUID()` for the state
 * token; per-request entropy is fine because we don't persist it on this PR
 * (the follow-up PR adds KV binding).
 */
export const handleInstallNew = (request: Request): Response => {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");

  if (owner === null) {
    return htmlResponse(renderOwnerChooser());
  }

  if (owner !== "" && !LOGIN_RE.test(owner)) {
    return jsonError(
      "invalid_owner",
      "`owner` must be a valid GitHub login (alphanumeric + dashes, 1–39 chars, not starting with a dash) or empty for a personal-account App",
      400,
    );
  }

  const manifest = resolveManifest(url.origin);
  const state = crypto.randomUUID();
  return htmlResponse(renderInstallForm(manifest, state, owner));
};

// ---------------------------------------------------------------------------
// `GET /v1/github/installed`
// ---------------------------------------------------------------------------

/**
 * The response shape from `POST /app-manifests/{code}/conversions`. Only the
 * fields we display are decoded; everything else (the full permissions block,
 * `owner`, `created_at`) is ignored.
 */
const ConversionResponse = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  html_url: Schema.String,
  webhook_secret: Schema.String,
  pem: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.String,
  // `owner.login` is what GitHub assigned as the App's owner — either the
  // signed-in user (personal-owned) or the org login (org-owned). We surface
  // it on the success page so the operator can confirm the owner matches
  // what they picked on the chooser; if they accidentally got prompted for
  // their personal account on the GitHub side, the page makes that visible.
  owner: Schema.Struct({ login: Schema.String }),
});
type ConversionResponse = Schema.Schema.Type<typeof ConversionResponse>;

/** A tagged error covering every way the conversion call can go wrong. */
class ConversionFailed extends Schema.TaggedError<ConversionFailed>()(
  "ConversionFailed",
  {
    /** Best-effort status; 0 when the fetch itself threw (network error). */
    status: Schema.Number,
    /** Whatever GitHub returned (already string-coerced). */
    body: Schema.String,
    /** Short tag describing the failure mode for the error page. */
    reason: Schema.Literal("network", "non_2xx", "bad_shape"),
  },
) {}

/** A `fetch` shape the route can be tested against without touching the network. */
export type FetchLike = typeof fetch;

/**
 * Exchange the manifest `code` for the App's credentials. Returns the parsed
 * conversion response on success; a tagged `ConversionFailed` otherwise.
 *
 * GitHub's docs (REST API § Apps § "Create a GitHub App from a manifest")
 * require `Accept: application/vnd.github+json` and recommend pinning
 * `X-GitHub-Api-Version: 2022-11-28`. The `code` itself is the bearer — no
 * `Authorization` header.
 */
const exchangeCode = (
  code: string,
  fetchImpl: FetchLike,
): Effect.Effect<ConversionResponse, ConversionFailed> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "FlareDispatch-Dispatcher",
            },
          },
        ),
      catch: (cause) =>
        new ConversionFailed({
          status: 0,
          body: cause instanceof Error ? cause.message : String(cause),
          reason: "network",
        }),
    });

    const text = yield* Effect.promise(() => res.text());

    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new ConversionFailed({
          status: res.status,
          body: text,
          reason: "non_2xx",
        }),
      );
    }

    // Parse + Schema-validate. Surface a tagged error on bad shape so the
    // caller renders an "unexpected response" page rather than crashing.
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new ConversionFailed({
          status: res.status,
          body: text,
          reason: "bad_shape",
        }),
    });

    return yield* Schema.decodeUnknown(ConversionResponse)(parsed).pipe(
      Effect.mapError(
        () =>
          new ConversionFailed({
            status: res.status,
            body: text,
            reason: "bad_shape",
          }),
      ),
    );
  });

/**
 * The "credentials shown ONCE" success page. EVERY interpolated value is run
 * through `htmlEscape` — even the App id, which is a number we control,
 * because the helper costs nothing and keeps the rule simple ("escape all
 * substitutions, no exceptions").
 *
 * The install URL pattern is `<html_url>/installations/new` — per GitHub's
 * Apps API, the App's `html_url` is the marketing page and
 * `<html_url>/installations/new` is the install picker.
 */
const renderSuccess = (app: ConversionResponse): string => {
  const id = htmlEscape(String(app.id));
  const slug = htmlEscape(app.slug);
  const name = htmlEscape(app.name);
  const htmlUrl = htmlEscape(app.html_url);
  const installUrl = htmlEscape(`${app.html_url}/installations/new`);
  const ownerLogin = htmlEscape(app.owner.login);
  const webhookSecret = htmlEscape(app.webhook_secret);
  const clientId = htmlEscape(app.client_id);
  const clientSecret = htmlEscape(app.client_secret);
  const pem = htmlEscape(app.pem);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlareDispatch — App created (${slug})</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { margin-bottom: 0; }
    .subtitle { color: #555; margin-top: 0.25rem; }
    .warn { background: #fff4e5; border-left: 4px solid #d97706; padding: 0.75rem 1rem; margin: 1.5rem 0; }
    pre { background: #f4f4f5; padding: 0.75rem 1rem; overflow-x: auto; font-family: ui-monospace, Menlo, monospace; font-size: 0.875rem; white-space: pre-wrap; word-break: break-all; }
    code { font-family: ui-monospace, Menlo, monospace; }
    .step { margin: 1.25rem 0; }
    .step h3 { margin-bottom: 0.25rem; }
    a.btn { display: inline-block; padding: 0.5rem 1rem; background: #2563eb; color: white; text-decoration: none; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>App created: ${name}</h1>
  <p class="subtitle">owner: <code>${ownerLogin}</code> &middot; slug: <code>${slug}</code> &middot; id: <code>${id}</code> &middot; <a href="${htmlUrl}" rel="noreferrer noopener">view on GitHub</a></p>

  <div class="warn">
    <strong>These credentials are shown ONCE.</strong> Copy them into <code>wrangler secret put</code> NOW — they will not be displayed again. If you lose them, regenerate from the App&#39;s settings page.
  </div>

  <h2>1. Stash the credentials in Worker secrets</h2>
  <p>Run each of these from your <code>flare-dispatch</code> checkout, pasting the value when prompted:</p>

  <div class="step">
    <h3><code>GITHUB_APP_ID</code></h3>
    <pre>wrangler secret put GITHUB_APP_ID
${id}</pre>
  </div>

  <div class="step">
    <h3><code>GITHUB_WEBHOOK_SECRET</code></h3>
    <pre>wrangler secret put GITHUB_WEBHOOK_SECRET
${webhookSecret}</pre>
  </div>

  <div class="step">
    <h3><code>GITHUB_APP_CLIENT_ID</code></h3>
    <pre>wrangler secret put GITHUB_APP_CLIENT_ID
${clientId}</pre>
  </div>

  <div class="step">
    <h3><code>GITHUB_APP_CLIENT_SECRET</code></h3>
    <pre>wrangler secret put GITHUB_APP_CLIENT_SECRET
${clientSecret}</pre>
  </div>

  <div class="step">
    <h3><code>GITHUB_APP_PRIVATE_KEY</code></h3>
    <p>This is a multi-line PEM. Paste the WHOLE block (including the BEGIN/END lines) into the <code>wrangler secret put</code> prompt, then press <kbd>Ctrl-D</kbd> on a blank line.</p>
    <pre>wrangler secret put GITHUB_APP_PRIVATE_KEY</pre>
    <p>PEM to paste:</p>
    <pre>${pem}</pre>
  </div>

  <h2>2. Install the App on a repo or org</h2>
  <p>The install picker shows every account/org you can install the App on. Pick <code>${ownerLogin}</code> (or any other org you admin) and choose the repos.</p>
  <p><a class="btn" href="${installUrl}" rel="noreferrer noopener">Install ${name}</a></p>

  <h2>3. Verify</h2>
  <p>After installing, dispatch a run from a workflow on the installed repo — the Dispatcher will create a check-run on the commit.</p>
</body>
</html>`;
};

/**
 * Render the error page for any `ConversionFailed`. The GitHub response body
 * is included so the operator can see what went wrong, but it goes through
 * `htmlEscape` — a hostile/buggy upstream cannot inject script tags.
 */
const renderError = (e: ConversionFailed): string => {
  const reasonText = Match.value(e.reason).pipe(
    Match.when("network", () => "Network error reaching api.github.com."),
    Match.when(
      "non_2xx",
      () =>
        `GitHub returned a non-2xx response (HTTP ${e.status}) — the most common cause is an expired or already-converted manifest code (codes are valid for one minute).`,
    ),
    Match.when(
      "bad_shape",
      () =>
        "GitHub returned a 2xx but the response body did not match the expected shape.",
    ),
    Match.exhaustive,
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlareDispatch — App creation failed</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    pre { background: #f4f4f5; padding: 0.75rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: 0.875rem; }
    .err { background: #fee2e2; border-left: 4px solid #dc2626; padding: 0.75rem 1rem; margin: 1.5rem 0; }
  </style>
</head>
<body>
  <h1>App creation failed</h1>
  <div class="err">${htmlEscape(reasonText)}</div>
  <p>GitHub response body (escaped):</p>
  <pre>${htmlEscape(e.body)}</pre>
  <p>Restart the flow at <a href="/v1/github/install/new">/v1/github/install/new</a>.</p>
</body>
</html>`;
};

/**
 * Handle `GET /v1/github/installed` — the manifest-conversion callback.
 *
 * Missing `code` → 400 JSON (this is a programmer error in the caller, not
 * something a human is going to see — fall back to JSON so it's grep-able in
 * logs). Successful exchange → 200 HTML. Any conversion failure → 502 HTML
 * with the upstream body inlined (escaped).
 */
export const handleInstalled = async (
  request: Request,
  fetchImpl: FetchLike = fetch,
): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    return jsonError(
      "missing_code",
      "expected `code` query parameter from the GitHub manifest callback",
      400,
    );
  }

  // The state echo is intentionally NOT validated yet — see file header. We
  // still read it so the (current) noop access is visible in code review.
  // biome-ignore lint/correctness/noUnusedVariables: see file header re: deferred state binding.
  const _state = url.searchParams.get("state");

  // Run as an `Either` so the typed failure surfaces as a value we can
  // pattern-match on — no `Cause` traversal, no defect handling.
  const result = await Effect.runPromise(
    Effect.either(exchangeCode(code, fetchImpl)),
  );

  return Either.match(result, {
    onLeft: (e) => htmlResponse(renderError(e), 502),
    onRight: (app) => htmlResponse(renderSuccess(app)),
  });
};
