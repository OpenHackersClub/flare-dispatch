// FlareDispatch Dispatcher — typed binding environment.
//
// One field per binding declared in wrangler.jsonc, plus the Worker secrets.
// V0 surface only: Workflow + R2 + D1 + Container. Queue / DO / Browser
// bindings are deferred to V1+ and intentionally absent here.

import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  /**
   * Shared HMAC-SHA256 secret — verifies inbound `POST /v1/dispatch/:run`
   * request bodies (specs/05-byoc.md § Secrets). A Worker secret, set via
   * `wrangler secret put HMAC_SECRET`.
   */
  readonly HMAC_SECRET: string;

  /** Workflow binding — instantiates RunWorkflow executions. */
  readonly RUNS_WORKFLOW: Workflow;

  /**
   * Container binding — the LEAN sandbox image, one instance per execution.
   * Typed as a `DurableObjectNamespace<Sandbox>` so `getSandbox(env.RUNS_SANDBOX,
   * id)` in `@flare-dispatch/runtime-cf` resolves the typed sandbox RPC surface.
   * The default for every run except those declaring `sandboxImage: "browser"`.
   */
  readonly RUNS_SANDBOX: DurableObjectNamespace<Sandbox>;

  /**
   * Container binding — the chromium-baked sandbox image (built from the same
   * Dockerfile with `WITH_BROWSER=true`). Runs declaring `sandboxImage:
   * "browser"` (e.g. `playwright-demo`, which launches Playwright's own chromium
   * inside the container) route here. Optional: a deploy that omits the second
   * container degrades by falling back to `RUNS_SANDBOX` rather than crashing on
   * an unbound namespace. NOTE the fallback is only non-fatal if the run's
   * command installs a browser itself (`playwright install …`) — a command that
   * relies on the baked image (the Dockerfile tells those callers to DROP the
   * install step) finds no chromium on the lean image and fails. So this is a
   * soft guard against a missing binding, not a guarantee browser runs work
   * without the second container.
   */
  readonly RUNS_SANDBOX_BROWSER?: DurableObjectNamespace<Sandbox>;

  /** R2 bucket — `logs/<execution-id>/<step>.ndjson` + `artifacts/...`. */
  readonly RUNS_STORAGE: R2Bucket;

  /** D1 database — `executions` + `steps` metadata tables. */
  readonly RUNS_METADATA: D1Database;

  /**
   * KV namespace backing the `config` capability — dynamic config + the
   * secret store the `loadSecrets` primitive resolves credentials through.
   * Optional: a deploy without it degrades to the dying `Config` stub (a
   * config-reading run fails loudly). See `@flare-dispatch/runtime-cf`
   * `makeConfigKvLive`.
   */
  readonly CONFIG_KV?: KVNamespace;

  /**
   * Receiver-level dedup KV — specs/04-gha-integration.md § Receiver dedup.
   * Keyed on the caller-supplied `Idempotency-Key` (or the semantic
   * `{run}:{repo}:{sha}` fallback) → the stored `executionId`. A repeat
   * delivery short-circuits to `202 {executionId}` without ever creating the
   * Workflow. Optional: absent → no receiver short-circuit, dedup falls back
   * to CF Workflows' platform-level `create({id})` no-op behaviour, which is
   * still correct just one RPC more expensive per redelivery.
   */
  readonly IDEMPOTENCY_KV?: KVNamespace;

  /**
   * Installation-token cache KV — specs/04-gha-integration.md § Check-runs
   * callback. Keyed by `installation_id`, value is the cached `{ token,
   * expiresAt }` so a Worker eviction does not force a fresh JWT exchange on
   * every check-run callback. Optional: absent → tokens cached in Worker
   * memory only (the V0 behaviour).
   */
  readonly INSTALL_TOKEN_KV?: KVNamespace;

  /**
   * GitHub App id — Worker secret, set via `wrangler secret put GITHUB_APP_ID`.
   * Numeric, carried as a string. With `GITHUB_APP_PRIVATE_KEY` it authorizes
   * the check-run callback; absent, the runtime degrades to a no-op `Checks`
   * Layer (the execution still runs, only the PR check-run is skipped).
   */
  readonly GITHUB_APP_ID?: string;

  /**
   * GitHub App private key — Worker secret, the PKCS#8 PEM piped via
   * `wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pem`. Pairs with
   * `GITHUB_APP_ID` to mint short-lived installation tokens (no PATs).
   */
  readonly GITHUB_APP_PRIVATE_KEY?: string;

  /**
   * GitHub App webhook secret — Worker secret. Verifies `X-Hub-Signature-256`
   * on `POST /v1/webhooks/github` (specs/04-gha-integration.md § Webhook
   * mode). Absent → the webhook route refuses (`503 webhook_not_configured`):
   * Webhook mode is opt-in, and silently accepting unsigned deliveries would
   * be a worse failure than rejecting.
   */
  readonly GITHUB_WEBHOOK_SECRET?: string;

  /**
   * Admin bearer token — Worker secret. Gates `POST /v1/admin/events/:wf_id`
   * (the `step.waitForEvent` signalling surface, specs/03-dsl.md
   * § Human-in-the-loop). Production deploys put Cloudflare Access in front
   * of the route and let CF Access enforce the SSO; the bearer token is the
   * cheap-and-correct fallback for deploys without CF Access. Absent → the
   * admin route refuses (`503 admin_not_configured`).
   */
  readonly ADMIN_TOKEN?: string;

  /**
   * OIDC signing key — ES256 private JWK as a JSON string. Worker secret
   * (`wrangler secret put OIDC_SIGNING_JWK < ./oidc-signing.jwk.json`).
   * Pairs with `OIDC_ISSUER_URL` to back the live `oidc` capability and the
   * `/.well-known/jwks.json` endpoint. Absent → `OidcDeferred` (a run that
   * calls `oidc.sign` fails with `OidcSigningFailed`). Spec: 03-dsl § oidc.
   */
  readonly OIDC_SIGNING_JWK?: string;

  /**
   * OIDC issuer URL — the Worker's stable origin (e.g.
   * `https://flare-dispatch.<account>.workers.dev`). Pinned by AWS / GCP
   * trust policies, so it must match exactly what's registered as the
   * OIDC provider. Worker secret (or var; semantics are the same).
   */
  readonly OIDC_ISSUER_URL?: string;

  /**
   * Browser Rendering CDP `/connect` WebSocket URL — Worker secret. The
   * `cdp-acceptance` run hands this (with `BROWSER_CDP_API_TOKEN` appended) to
   * the container's Playwright process. Absent, the runtime degrades to the
   * dying `Browser` stub — a browser run fails loudly, non-browser runs are
   * unaffected.
   */
  readonly BROWSER_CDP_CONNECT_URL?: string;

  /**
   * Cloudflare API token authorizing the Browser Rendering connect — Worker
   * secret, paired with `BROWSER_CDP_CONNECT_URL`. Also the bearer token the
   * `GET /v1/browser/cdp` proxy route validates: a `cdp-acceptance` container
   * connects with `?token=<this>` (or `Authorization: Bearer <this>`).
   */
  readonly BROWSER_CDP_API_TOKEN?: string;

  /**
   * Cloudflare Browser Rendering binding. When present, `GET /v1/browser/cdp`
   * bridges a container's `connectOverCDP` to a Browser Rendering session via
   * `env.BROWSER.fetch(/v1/acquire)` + `/v1/devtools/browser/<sessionId>` — the
   * only supported way to reach CF Browser Rendering CDP (it is not a public,
   * token-dialable WebSocket). Absent → that route 503s; non-browser runs are
   * unaffected. Declared as `"browser": { "binding": "BROWSER" }` in wrangler.
   */
  readonly BROWSER?: Fetcher;

  /**
   * CF Browser session `keep_alive` ceiling in ms for the `/v1/browser/cdp`
   * proxy (default 600000 = CF's documented 10-min max). A var, not a secret.
   */
  readonly KEEP_ALIVE_MS?: string;

  /**
   * The Worker's public domain (e.g. `flare-dispatch.<account>.workers.dev`,
   * or a custom domain) the `sandbox` capability's `exposePort` uses to build
   * container preview URLs — the publicly-reachable URL a cloud browser dials
   * instead of the container's `localhost`. A var, not a secret (it is the
   * public origin, not a credential). Absent → `exposePort` fails with
   * `ExposePortFailed`, so a browser-acceptance run that needs a reachable URL
   * fails loudly. Non-browser runs are unaffected.
   */
  readonly SANDBOX_PREVIEW_HOSTNAME?: string;

  /**
   * The dispatcher's own public origin (e.g.
   * `https://flare-dispatch.<account>.workers.dev`, or a custom domain) —
   * prefixed onto the `/v1/artifacts/...` URLs runs upload so the links a
   * GitHub check-run summary embeds are absolute (GitHub resolves relative
   * markdown links against `github.com`, breaking them). A var, not a secret.
   * Optional: HTTP dispatches fall back to the dispatch request's own origin;
   * cron-scheduled runs have no request, so artifact links in their summaries
   * stay relative (GitHub-broken) until this is set. Distinct from
   * `SANDBOX_PREVIEW_HOSTNAME`, which is the *sandbox preview* domain — they
   * may differ (e.g. previews on a wildcard subdomain).
   */
  readonly PUBLIC_ORIGIN?: string;

  /**
   * Cloudflare Email Routing `send_email` binding — backs the `email`
   * capability + the Workflow's completion-notify (`notify.emails` in the
   * dispatch body). Declared as `"send_email": [{ "name": "SEND_EMAIL" }]` in
   * wrangler. Cloudflare only delivers to **verified destination addresses** on
   * the zone, and `from` must be `EMAIL_FROM` on that zone. Absent (no Email
   * Routing configured) → the no-op `Email` Layer: notifications are logged and
   * skipped, never failing a run.
   */
  readonly SEND_EMAIL?: SendEmail;

  /**
   * Verified sender address for completion-notify email — the `From`. A var,
   * not a secret (a public address, not a credential). Must be on the Email
   * Routing zone `SEND_EMAIL` is bound to. Absent → `Email` degrades to the
   * no-op Layer even when `SEND_EMAIL` is present.
   */
  readonly EMAIL_FROM?: string;

  /** Optional display name for the notify `From` header (e.g. "FlareDispatch"). */
  readonly EMAIL_FROM_NAME?: string;

  /**
   * Optional comma-separated allowlist of recipient addresses. When set, a
   * `notify.emails` recipient not on it is rejected before the provider call —
   * a cheap guard so a dispatch can't fan notifications at arbitrary addresses
   * on top of Cloudflare's own verified-destination enforcement. A var.
   */
  readonly EMAIL_ALLOWED_RECIPIENTS?: string;

  /**
   * Cloudflare Workers AI binding — backs the `modelGateway` capability the
   * `pr-review` engine calls. The binding IS the auth (Workers AI is
   * account-billed), so no model API key is configured. Declared as
   * `"ai": { "binding": "AI" }` in wrangler. Absent (no `"ai"` binding) → the
   * dying `ModelGateway` stub: a model-calling run fails loudly, others are
   * unaffected.
   */
  readonly AI?: Ai;

  /**
   * Optional AI Gateway id the `modelGateway` routes Workers AI calls through
   * (for caching / rate-limiting / observability). A var, not a secret. Absent
   * / empty → call Workers AI directly (no gateway). Set per-deploy via the
   * `vars` block in wrangler (e.g. wrangler.numu.jsonc).
   */
  readonly AI_GATEWAY_ID?: string;

  /**
   * Admission-semaphore slots per container pool (issue #109) — a var, not a
   * secret, carried as a string like every wrangler var. At most this many
   * runs are in flight per pool (lean / browser); the rest queue FIFO in D1.
   * Keep it ≤ each container's `max_instances` (16 today; see the paired
   * comments in wrangler.jsonc) — operators may set it slightly below for
   * slot-turnover headroom. Absent / unparsable → defaults to 16
   * (`ADMISSION_CAP_DEFAULT`), same degrade pattern as
   * `CLOUDFLARE_ACCOUNT_ID` below.
   */
  readonly ADMISSION_CAP?: string;

  /**
   * Cloudflare account id (the 32-hex id in the dashboard URL) — a var, not a
   * secret. When set, `RunWorkflow` builds a `details_url` on the GitHub
   * check-run pointing at the Cloudflare Workflows instance page
   * (`dash.cloudflare.com/<id>/workers/workflows/runs-workflow/instance/<executionId>`),
   * so a reviewer jumps from the PR check straight to the execution's step
   * logs. Absent (the BYOC default — each deploy owns its account) → no
   * `details_url`, the check-run renders exactly as before. Set with
   * `wrangler` via the `vars` block in wrangler.jsonc.
   */
  readonly CLOUDFLARE_ACCOUNT_ID?: string;

  /**
   * Cloudflare API token (scoped, e.g. `Pages:Read`) — a Worker secret, set via
   * `wrangler secret put CLOUDFLARE_API_TOKEN`. Backs the read-only `cloudflare`
   * capability the `ci-triage` run uses to read failed Pages deployments
   * (paired with `CLOUDFLARE_ACCOUNT_ID`). Absent → the `cloudflare` capability
   * degrades to empty (the triage sweep finds nothing CF-side). Non-CF runs are
   * unaffected. Read-only: mutating CF state stays a `wrangler` / CI concern.
   */
  readonly CLOUDFLARE_API_TOKEN?: string;
}
