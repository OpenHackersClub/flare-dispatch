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
   * Browser Rendering CDP `/connect` WebSocket URL — Worker secret. The
   * `cdp-acceptance` run hands this (with `BROWSER_CDP_API_TOKEN` appended) to
   * the container's Playwright process. Absent, the runtime degrades to the
   * dying `Browser` stub — a browser run fails loudly, non-browser runs are
   * unaffected.
   */
  readonly BROWSER_CDP_CONNECT_URL?: string;

  /**
   * Cloudflare API token authorizing the Browser Rendering connect — Worker
   * secret, paired with `BROWSER_CDP_CONNECT_URL`.
   */
  readonly BROWSER_CDP_API_TOKEN?: string;
}
