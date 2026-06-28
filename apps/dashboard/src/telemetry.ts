// Browser RUM (real-user monitoring) for the dashboard SPA, shipped to HyperDX.
//
// Config is injected at BUILD time via Vite env (VITE_HYPERDX_*, declared in
// vite-env.d.ts) and baked into the bundle. The Ingestion API Key is a public,
// client-side key by design — like a Sentry DSN — so embedding it in the
// browser bundle is expected. The deploy workflow sources it from the
// HYPERDX_API_KEY repo secret (.github/workflows/deploy-dispatcher.yml).
//
// `initTelemetry` is a NO-OP when no key is configured (local `vite dev`, or a
// deploy made before the secret is set), so it never breaks an unconfigured
// build — it just sends nothing.
//
// The SDK (rrweb session replay + OTel, ~157 KB gzip) is loaded via dynamic
// import() so Vite splits it into its OWN async chunk, keeping it off the
// dashboard's critical path. The import is kicked off at startup so RUM still
// initializes within a few hundred ms — it just doesn't block first paint or
// app interactivity. The trade-off is that the very earliest events (before the
// chunk resolves) aren't captured; acceptable for an internal ops dashboard.

/** Escape a host so it can be embedded literally in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function initTelemetry(): void {
  const apiKey = import.meta.env.VITE_HYPERDX_API_KEY;
  if (apiKey === undefined || apiKey === "") return;

  const service = import.meta.env.VITE_HYPERDX_SERVICE ?? "flare-dispatch-dashboard";
  // Self-hosted instances point this at their OTLP collector; HyperDX Cloud
  // leaves it unset and the SDK uses its default ingest endpoint.
  const url = import.meta.env.VITE_HYPERDX_URL;

  void import("@hyperdx/browser")
    .then(({ default: HyperDX }) => {
      HyperDX.init({
        apiKey,
        service,
        ...(url !== undefined && url !== "" ? { url } : {}),
        // Add W3C trace context to the SPA's same-origin /v1 fetches so they
        // stitch to backend spans if/when the dispatcher Worker emits OTel.
        // Same-origin requests never trigger a CORS preflight, so the extra
        // header is safe.
        tracePropagationTargets: [new RegExp(escapeRegExp(window.location.host), "i")],
        consoleCapture: true,
        // Session replay is ON (SDK default) so we can see the screen behind an
        // error — but never capture typed input values.
        maskAllInputs: true,
        // advancedNetworkCapture is intentionally OFF: the /v1/dashboard.json
        // feed carries HMAC-tokened logsUrl/demosUrl deep links in its body, and
        // capturing response bodies would ship those tokens to HyperDX. We still
        // get a span per fetch (timing + status), just not the payload.
      });
    })
    // Telemetry must never break the app — swallow a failed chunk load.
    .catch(() => {});
}
