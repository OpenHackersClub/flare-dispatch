// @flare-dispatch/demo-agent — CDP attach + low-level browser ops.
//
// The agent attaches via puppeteer-core's `Browser.connect({ browserWSEndpoint })`
// against the WebSocket URL the run hands it. The run gets that URL from the
// dispatcher's `browser.newCDPSession` primitive, which already appends
// `?recording=true` so the Browser Rendering session emits rrweb events the
// whole time we're attached.
//
// This module is the only place that imports `puppeteer-core` so the LLM loop
// and the recorder stay easy to unit-test (they take a `CdpSession`
// interface, not a Puppeteer instance).
//
// Spec: specs/03-dsl.md § browser, packages/runtime-cf/src/browser-cf.ts.

import { Effect } from "effect";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { CdpAttachFailed, CdpCommandFailed } from "./errors.js";
import { VIEWPORTS, type ViewportPreset } from "./schemas.js";

/**
 * Minimal surface the play loop + recorder need from a live CDP session.
 * Exposed as an interface so tests can inject a fake without spinning up a
 * real WebSocket; the live impl is `attachCdp` below.
 */
export interface CdpSession {
  /** Navigate the active page; resolves when the navigation commits. */
  readonly goto: (url: string) => Effect.Effect<void, CdpCommandFailed>;
  /** The page's current URL (puppeteer `page.url()`). */
  readonly currentUrl: () => Effect.Effect<string, never>;
  /** Click an element by accessibility node id or CSS selector. */
  readonly click: (target: string) => Effect.Effect<void, CdpCommandFailed>;
  /** Focus an element and type a string into it. */
  readonly type: (
    target: string,
    text: string,
  ) => Effect.Effect<void, CdpCommandFailed>;
  /** Dispatch a single keyboard event by CDP key name. */
  readonly key: (key: string) => Effect.Effect<void, CdpCommandFailed>;
  /** Wait `ms` milliseconds (clamped to 5_000 by the caller). */
  readonly wait: (ms: number) => Effect.Effect<void, never>;
  /** Capture a PNG screenshot to the absolute path. */
  readonly screenshot: (
    path: string,
  ) => Effect.Effect<void, CdpCommandFailed>;
  /**
   * Snapshot the accessibility tree of the current page — the input the model
   * picks its next action from. Returns a compact JSON-stringified tree.
   */
  readonly accessibilitySnapshot: () => Effect.Effect<
    string,
    CdpCommandFailed
  >;
  /** Browser Rendering session id — what the recording REST API keys on. */
  readonly sessionId: () => Effect.Effect<string, CdpCommandFailed>;
  /** Close the page + disconnect the browser. */
  readonly close: () => Effect.Effect<void, never>;
}

const classifyAttachError = (e: unknown): CdpAttachFailed["reason"] => {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e);
  if (msg.includes("invalid url") || msg.includes("invalid-url")) return "invalid-url";
  if (msg.includes("econnrefused")) return "connect-refused";
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthor"))
    return "auth-failed";
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  return "unknown";
};

const wrapCmd = <T>(
  method: string,
  thunk: () => Promise<T>,
): Effect.Effect<T, CdpCommandFailed> =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) =>
      new CdpCommandFailed({
        method,
        message: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    // Bound every CDP op so a single hung action (a click on an unresponsive
    // element, a goto to a page that never finishes loading) can't block the
    // play loop past its `--max-sec` budget — which on the dispatcher overran
    // the exec's `timeoutSec` and surfaced as ExecTimeout. On timeout the op
    // becomes a normal CdpCommandFailed the loop records and moves past.
    Effect.timeoutFail({
      duration: "45 seconds",
      onTimeout: () =>
        new CdpCommandFailed({
          method,
          message: `${method} timed out after 45s`,
        }),
    }),
  );

/** Apply the viewport preset via Emulation.setDeviceMetricsOverride. */
export const applyViewport = (
  page: Page,
  preset: ViewportPreset,
): Effect.Effect<void, CdpCommandFailed> => {
  const dims = VIEWPORTS[preset];
  return wrapCmd("Emulation.setDeviceMetricsOverride", () =>
    page.setViewport({
      width: dims.width,
      height: dims.height,
      deviceScaleFactor: dims.deviceScaleFactor,
      isMobile: dims.mobile,
    }),
  );
};

/**
 * Attach to Browser Rendering over CDP at `wsEndpoint`. Resolves once the
 * default page is connected; the returned `CdpSession` carries an `accessor`
 * for the underlying puppeteer `Browser` so tests + the live recorder can
 * extract the session id.
 */
export const attachCdp = (
  wsEndpoint: string,
): Effect.Effect<
  { readonly browser: Browser; readonly page: Page; readonly session: CdpSession },
  CdpAttachFailed
> =>
  Effect.gen(function* () {
    if (!/^wss?:\/\//.test(wsEndpoint)) {
      return yield* Effect.fail(
        new CdpAttachFailed({
          wsEndpoint,
          reason: "invalid-url",
          message: `--cdp-ws must start with ws:// or wss:// (got: ${wsEndpoint})`,
        }),
      );
    }

    const browser = yield* Effect.tryPromise({
      try: () =>
        puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: null,
        }),
      catch: (e) =>
        new CdpAttachFailed({
          wsEndpoint,
          reason: classifyAttachError(e),
          message: e instanceof Error ? e.message : String(e),
        }),
    }).pipe(
      // Bound the connect — `puppeteer.connect` to a Browser Run re-attach
      // endpoint can hang indefinitely if the session is wedged, which (before
      // the play loop's deadline even starts) would otherwise wedge the whole
      // play. Fail fast as a normal attach error the caller records.
      Effect.timeoutFail({
        duration: "30 seconds",
        onTimeout: () =>
          new CdpAttachFailed({
            wsEndpoint,
            reason: "timeout",
            message: "puppeteer.connect timed out after 30s",
          }),
      }),
    );

    const page = yield* Effect.tryPromise({
      try: async () => {
        const existing = await browser.pages();
        return existing.length > 0 && existing[0] !== undefined
          ? existing[0]
          : await browser.newPage();
      },
      catch: (e) =>
        new CdpAttachFailed({
          wsEndpoint,
          reason: "unknown",
          message: e instanceof Error ? e.message : String(e),
        }),
    });

    // When CF Access service-token creds are in the env, set them as extra HTTP
    // headers so the browser can reach a Cloudflare-Access-gated target. The
    // numu staging Pages site 302s every request to the Access login otherwise,
    // so the agent would only ever see the login wall. Best-effort.
    const cfAccessId = process.env["CF_ACCESS_CLIENT_ID"];
    const cfAccessSecret = process.env["CF_ACCESS_CLIENT_SECRET"];
    if (cfAccessId !== undefined && cfAccessSecret !== undefined) {
      yield* Effect.tryPromise({
        try: () =>
          page.setExtraHTTPHeaders({
            "CF-Access-Client-Id": cfAccessId,
            "CF-Access-Client-Secret": cfAccessSecret,
          }),
        catch: (e) =>
          new CdpAttachFailed({
            wsEndpoint,
            reason: "unknown",
            message: e instanceof Error ? e.message : String(e),
          }),
      });
    }

    // Resolve an agent-supplied target to an element. The agent reads the
    // ACCESSIBILITY tree, so it usually supplies an accessible name ("Home",
    // "Sign in") — not a CSS selector. Try puppeteer's ARIA selector first (by
    // accessible name/role), then a raw CSS selector, then visible text. This is
    // what lets the agent operate a real app it has only ever seen as an a11y
    // tree, instead of failing every `page.click("Home")` as a bad CSS selector.
    const resolveElement = async (target: string) => {
      for (const sel of [`::-p-aria(${target})`, target, `::-p-text(${target})`]) {
        try {
          const el = await page.$(sel);
          if (el !== null) return el;
        } catch {
          // selector invalid for this strategy — fall through to the next.
        }
      }
      return null;
    };

    const session: CdpSession = {
      goto: (url) =>
        wrapCmd("Page.navigate", () =>
          page.goto(url, { waitUntil: "domcontentloaded" }).then(() => undefined),
        ),
      currentUrl: () => Effect.sync(() => page.url()),
      click: (target) =>
        wrapCmd("Input.click", async () => {
          const el = await resolveElement(target);
          if (el === null) {
            throw new Error(
              `no element matching "${target}" (tried accessible-name, CSS, and text)`,
            );
          }
          await el.click();
        }),
      type: (target, text) =>
        wrapCmd("Input.type", async () => {
          const el = await resolveElement(target);
          if (el === null) {
            throw new Error(
              `no element matching "${target}" (tried accessible-name, CSS, and text)`,
            );
          }
          await el.focus();
          await el.type(text);
        }),
      key: (key) =>
        wrapCmd("Input.keyboard", () => page.keyboard.press(key as never)),
      wait: (ms) => Effect.sleep(`${Math.min(Math.max(ms, 0), 5_000)} millis`),
      screenshot: (path) =>
        wrapCmd("Page.captureScreenshot", () =>
          page
            .screenshot({ path: path as `${string}.png`, type: "png" })
            .then(() => undefined),
        ),
      accessibilitySnapshot: () =>
        wrapCmd("Accessibility.getFullAXTree", async () => {
          const tree = await page.accessibility.snapshot({ interestingOnly: true });
          return JSON.stringify(tree ?? { role: "WebArea", children: [] });
        }),
      sessionId: () =>
        wrapCmd("Browser.sessionId", async () => {
          // Browser Rendering exposes the session id via the target's
          // `_session._sessionId` on the default page. Puppeteer abstracts
          // this; we read it through CDPSession.id() on the page's primary
          // CDP session.
          const cdp = await page.createCDPSession();
          const id = cdp.id();
          await cdp.detach();
          return id;
        }),
      close: () =>
        Effect.tryPromise({
          try: async () => {
            // DISCONNECT ONLY — never `page.close()`. The demo commands
            // (record start → play → record stop) share ONE pre-acquired
            // Browser Run session via `?browser_session=<id>` re-attach;
            // closing the session's only page makes the browser exit, killing
            // the session, and the NEXT command's attach fails. The page (and
            // the app state loaded into it) must outlive each short-lived CLI
            // connect; only `record stop`'s explicit `browser.close()` ends
            // the session (which is also what finalizes the recording).
            await browser.disconnect();
          },
          catch: () => undefined,
        }).pipe(Effect.ignore),
    };

    return { browser, page, session };
  });
