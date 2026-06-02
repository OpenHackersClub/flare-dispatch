// FlareDispatch Dispatcher — sandbox image routing.
//
// A run declares which baked container image it needs via `sandboxImage`
// (define-run.ts § SandboxImage); the dispatcher maps that to one of the
// deployed Container bindings. This module holds ONLY the pure selection logic
// (no `@cloudflare/sandbox` / `cloudflare:workers` imports) so it stays testable
// under plain Node + Vitest 2, matching the rest of the dispatcher's route code.
//
// The routing axis is DISTINCT from `limits.requiresBrowser`: that reserves a CF
// Browser Rendering CDP slot (the run connects *out* to a CF-managed browser and
// stays on the lean image); `sandboxImage` picks the image the container boots.

import type { SandboxImage } from "@flare-dispatch/core";

/**
 * Pick the Container binding for a run's declared `sandboxImage`. Generic over
 * the binding type so it's unit-testable with sentinels (the real call passes
 * `DurableObjectNamespace<Sandbox>` values).
 *
 * Rules:
 *   - `"browser"` + a bound browser image → the browser binding.
 *   - `"browser"` + NO browser binding → the lean binding (graceful degrade: a
 *     deploy without the second container still runs the browser run, it just
 *     downloads chromium at runtime — the pre-#66 behaviour — rather than
 *     crashing on an unbound namespace).
 *   - `"lean"` / `undefined` (the default) → the lean binding.
 */
export const selectSandboxNs = <T>(
  sandboxImage: SandboxImage | undefined,
  bindings: { readonly lean: T; readonly browser: T | undefined },
): T =>
  sandboxImage === "browser" && bindings.browser !== undefined
    ? bindings.browser
    : bindings.lean;
