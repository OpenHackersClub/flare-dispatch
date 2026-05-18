// @flare-dispatch/core — Browser / Cache / Config fakes.
//
// V0's `offload-test` run touches only sandbox / artifact / io / checks /
// executions, but `RunContext` is the union of *all* capability services — so
// `CFRuntimeTest` still needs a Layer for `Browser`, `Cache`, and `Config` to
// be complete. These three fakes are intentionally minimal: enough to satisfy
// the Tag, no inspectable state. A V1+ run that actually exercises them gets a
// richer fake then.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § Layers.

import { Effect, Layer, Option } from "effect";
import { BrowserUnavailable } from "../errors";
import { Browser, type BrowserService } from "../services/browser";
import { Cache, type CacheService } from "../services/cache";
import { Config, type ConfigService } from "../services/config";

/**
 * Browser fake — every call fails `BrowserUnavailable` with `reason: "quota"`.
 * V0 has no browser run; a test that needs a working browser builds its own.
 */
export const BrowserFake: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newPage: () => Effect.fail(new BrowserUnavailable({ reason: "quota" })),
    newCDPSession: () =>
      Effect.fail(new BrowserUnavailable({ reason: "quota" })),
  }))(),
);

/** Cache fake — `restoreOr` always misses (runs `onMiss`), `save` is a no-op. */
export const CacheFake: Layer.Layer<Cache> = Layer.succeed(
  Cache,
  ((): CacheService => ({
    restoreOr: (opts) => opts.onMiss(),
    save: () => Effect.void,
  }))(),
);

/** Config fake — every key is unset, so a run falls back to its defaults. */
export const ConfigFake: Layer.Layer<Config> = Layer.succeed(
  Config,
  ((): ConfigService => ({
    get: () => Effect.succeed(undefined),
    getJSON: () => Effect.succeed(Option.none()),
  }))(),
);
