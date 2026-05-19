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
}
