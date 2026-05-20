// @flare-dispatch/runtime-cf — BrowserRenderingLive: the live `browser` capability.
//
// Backs `BrowserService` for the `cdp-acceptance` run. The acceptance suite
// runs Playwright *inside the sandbox container*, so what the run needs from
// this capability is a CDP WebSocket endpoint the container's Playwright
// process can dial — `playwright.chromium.connectOverCDP(process.env.CDP_WS_URL)`.
//
// --- The connect model (chosen in PR9) --------------------------------------
//
// The container reaches Cloudflare Browser Rendering directly over its
// `/connect` WebSocket, authenticated with a Cloudflare API token — it does
// NOT go through the Worker's `BROWSER` binding (that path only exposes CDP to
// Worker code, not to an arbitrary container process). `newCDPSession` therefore
// just composes the endpoint URL the container dials; the token rides as a
// query parameter (a CDP WS client cannot set request headers).
//
// The connect URL + token are operator-provided deploy config (`config.connectUrl`
// / `config.apiToken`, from the `BROWSER_CDP_*` Worker secrets) rather than a
// hardcoded constant — the exact Browser Rendering connect surface is pinned at
// deploy time, not baked into this Layer. A deploy with no `BROWSER_CDP_CONNECT_URL`
// gets the dying `BrowserDeferred` stub (see runtime.ts).
//
// --- Verification scope ------------------------------------------------------
//
// `vitest-pool-workers` / Miniflare has neither a container runtime nor Browser
// Rendering, so the live connect cannot be exercised here — this Layer is
// verified by typecheck + `wrangler deploy --dry-run`; the end-to-end attach is
// a `wrangler dev` smoke. The endpoint-composition logic is pure and unit-tested.
//
// Spec: specs/03-dsl.md § browser, specs/pm/plan.md § V1 / V2 plan — PR9.

import { Effect, Layer } from "effect";
import { Browser, type BrowserService } from "@flare-dispatch/core";

/** Deploy config for the live `browser` capability. */
export type BrowserRenderingConfig = {
  /**
   * The Browser Rendering CDP `/connect` WebSocket URL the container dials.
   * Operator-pinned (`BROWSER_CDP_CONNECT_URL`) — the exact connect surface is
   * not baked into this Layer.
   */
  readonly connectUrl: string;
  /**
   * Cloudflare API token authorizing the connect. Appended as a `token` query
   * parameter. Optional — omit when `connectUrl` already carries auth.
   */
  readonly apiToken?: string;
};

/** Compose the CDP endpoint the container dials, appending the token if any. */
export const composeCdpEndpoint = (config: BrowserRenderingConfig): string => {
  if (config.apiToken === undefined) return config.connectUrl;
  const sep = config.connectUrl.includes("?") ? "&" : "?";
  return `${config.connectUrl}${sep}token=${encodeURIComponent(config.apiToken)}`;
};

/**
 * Build the live `Browser` Layer from the Browser Rendering deploy config.
 *
 * @param config  the `/connect` URL + API token (`BROWSER_CDP_*` secrets).
 */
export const makeBrowserRenderingLive = (
  config: BrowserRenderingConfig,
): Layer.Layer<Browser> => {
  const service: BrowserService = {
    newCDPSession: ({ targetUrl: _targetUrl }) =>
      // Pure URL composition — the container, not the Worker, opens the WS.
      // `targetUrl` is the app the *suite* navigates to once connected; it is
      // not needed to attach to the browser itself.
      Effect.succeed({
        wsEndpoint: composeCdpEndpoint(config),
        close: Effect.void,
      }),

    // REST-mode `newPage` (Worker-side Puppeteer) is not used by `cdp-acceptance`
    // and would need the `BROWSER` binding + `@cloudflare/puppeteer`; it lands
    // with the first run that needs it.
    newPage: () =>
      Effect.die(
        "browser.newPage: REST mode not implemented — cdp-acceptance uses newCDPSession",
      ),
  };

  return Layer.succeed(Browser, service);
};
