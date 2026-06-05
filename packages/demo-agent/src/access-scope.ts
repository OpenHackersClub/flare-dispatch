// @flare-dispatch/demo-agent — which hosts may receive CF Access headers.
//
// The agent's browser carries a CF Access service-token pair so it can reach
// an Access-gated target. Sending those headers on EVERY request (the old
// `page.setExtraHTTPHeaders` behaviour) broke the app under test: the
// numu-staging diagnosis (2026-06-05) showed cross-origin loads — Clerk's
// `clerk.browser.js`, Google Fonts — failing with `net::ERR_INVALID_REDIRECT`
// + CORS blocks once the extra headers rode along, leaving the SPA body blank
// behind its dev banner and every story wandering to its action budget. It is
// also a credential leak: the service-token secret was handed to every
// third-party origin the page touched.
//
// `accessHeaderHostAllow` builds the predicate the request-interception hook
// uses: allow the app-under-test's own host (derived from the `--url` the
// caller already passes) plus any extra hosts the operator names in
// `CF_ACCESS_HOSTS` (comma-separated, e.g. a separately-gated API origin).
// Pure + unit-tested; the puppeteer wiring lives in `cdp.ts`.

/**
 * Build a host predicate for CF Access header injection.
 *
 * @param appUrl        the app-under-test URL (the play/record `--url`);
 *                      its host is always allowed. `undefined`/unparseable →
 *                      contributes nothing.
 * @param extraHostsCsv comma-separated additional hosts (`CF_ACCESS_HOSTS`),
 *                      exact-match, whitespace-tolerant.
 * @returns a predicate over a request URL's host, or `null` when NO host
 *          information exists at all — the caller then falls back to the
 *          legacy global-header behaviour rather than silently sending the
 *          token nowhere.
 */
export const accessHeaderHostAllow = (
  appUrl: string | undefined,
  extraHostsCsv: string | undefined,
): ((host: string) => boolean) | null => {
  const allowed = new Set<string>();
  if (appUrl !== undefined) {
    try {
      allowed.add(new URL(appUrl).host);
    } catch {
      // unparseable --url — contributes nothing; extra hosts may still apply.
    }
  }
  for (const raw of (extraHostsCsv ?? "").split(",")) {
    const host = raw.trim();
    if (host !== "") allowed.add(host);
  }
  if (allowed.size === 0) return null;
  return (host) => allowed.has(host);
};
