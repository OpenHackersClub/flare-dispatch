// @flare-dispatch/runtime-cf — deferred V0 capability Layers.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeLive`
// must supply a Layer for every Tag — even the ones a given deploy can't back.
// Per specs/pm/plan.md § 1 ("All other DSL surface stubbed to `Effect.die`")
// an unbacked capability fails loudly rather than silently mis-behaving.
//
// Live as of PR8: `Cache` (R2-backed, see cache-r2.ts — always wired) and
// `Config` (KV-backed, see config-kv.ts — wired when the `CONFIG_KV` binding
// is present, else `ConfigDeferred` below). `Checks` went live in PR6.
// `Browser` is the last V0 stub — Browser Rendering lands in V2 (PR9).
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4 + § PR6 + § PR8.

import { Effect, Layer } from "effect";
import { Browser, type BrowserService, Config, type ConfigService } from "@flare-dispatch/core";

/** Browser — Browser Rendering binding deferred to V2 (PR9). */
export const BrowserDeferred: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newPage: () => Effect.die("browser.newPage: not implemented until V2"),
    newCDPSession: () =>
      Effect.die("browser.newCDPSession: not implemented until V2"),
  }))(),
);

/**
 * Config — the fallback when a deploy has no `CONFIG_KV` namespace. A run that
 * reads config on such a deploy dies rather than silently seeing every key as
 * unset. A deploy with the binding gets the live `makeConfigKvLive` Layer.
 */
export const ConfigDeferred: Layer.Layer<Config> = Layer.succeed(
  Config,
  ((): ConfigService => ({
    get: () => Effect.die("config.get: no CONFIG_KV binding on this deploy"),
    getJSON: () =>
      Effect.die("config.getJSON: no CONFIG_KV binding on this deploy"),
  }))(),
);

