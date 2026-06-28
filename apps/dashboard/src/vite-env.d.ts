/// <reference types="vite/client" />

// Build-time configuration injected by Vite (see telemetry.ts). All optional:
// an unconfigured build (local `vite dev`, or a deploy before the HyperDX repo
// secret is set) simply has no key, and browser RUM stays a no-op.
interface ImportMetaEnv {
  /** HyperDX Ingestion API Key. Unset → RUM disabled. */
  readonly VITE_HYPERDX_API_KEY?: string;
  /** Service name events are attributed to. Default `flare-dispatch-dashboard`. */
  readonly VITE_HYPERDX_SERVICE?: string;
  /** OTLP collector URL — self-hosted HyperDX only. Unset → HyperDX Cloud. */
  readonly VITE_HYPERDX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
