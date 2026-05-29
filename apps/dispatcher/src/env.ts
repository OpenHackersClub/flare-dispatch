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
   * Container binding — one sandbox instance per execution. Typed as a
   * `DurableObjectNamespace<Sandbox>` so `getSandbox(env.RUNS_SANDBOX, id)` in
   * `@flare-dispatch/runtime-cf` resolves the typed sandbox RPC surface.
   */
  readonly RUNS_SANDBOX: DurableObjectNamespace<Sandbox>;

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
}
