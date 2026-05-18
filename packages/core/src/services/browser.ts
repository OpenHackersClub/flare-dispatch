// @flare-dispatch/core — the `browser` capability (Browser Rendering access).
//
// REST mode (`newPage`) for short, stateless page interactions; CDP mode
// (`newCDPSession`) for a direct WebSocket attach to a managed Chromium.
//
// Spec: specs/03-dsl.md § browser.

import { Context, Effect } from "effect";
import type { BrowserUnavailable } from "../errors";

/** A managed page — Puppeteer's page object wrapped in Effect signatures. */
export type Page = {
  readonly goto: (url: string) => Effect.Effect<void, BrowserUnavailable>;
  readonly close: Effect.Effect<void>;
};

/** A direct CDP attach: typed Network / Page / Runtime event streams. */
export type CDPSession = {
  readonly wsEndpoint: string;
  readonly close: Effect.Effect<void>;
};

export interface BrowserService {
  readonly newPage: (opts?: {
    viewport?: { w: number; h: number };
  }) => Effect.Effect<Page, BrowserUnavailable>;
  readonly newCDPSession: (opts: {
    targetUrl: string;
  }) => Effect.Effect<CDPSession, BrowserUnavailable>;
}

export class Browser extends Context.Tag("@flare-dispatch/core/Browser")<
  Browser,
  BrowserService
>() {}

export const browser = {
  newPage: (opts?: { viewport?: { w: number; h: number } }) =>
    Effect.flatMap(Browser, (b) => b.newPage(opts)),
  newCDPSession: (opts: { targetUrl: string }) =>
    Effect.flatMap(Browser, (b) => b.newCDPSession(opts)),
} as const;
