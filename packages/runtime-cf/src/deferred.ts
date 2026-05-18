// @flare-dispatch/runtime-cf — deferred V0 capability Layers.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeLive`
// must supply a Layer for every Tag — even the ones no V0 run exercises.
// `offload-test` touches only sandbox / artifact / io / executions / step, so
// `Browser`, `Cache`, and `Config` have no live binding in V0; per
// specs/pm/plan.md § 1 ("All other DSL surface stubbed to `Effect.die`") they
// fail loudly rather than silently mis-behaving.
//
// `Checks` is special: it is on the V0 *acceptance* path (the run's verdict
// must reach a PR check-run), but the live GitHub App binding —
// `ChecksGithubLive` — lands in PR6. Until then `CFRuntimeLive` carries a
// deferred `Checks` stub so the runtime is a complete `RunContext`; PR6 swaps
// this Layer for the real one. `offload-test` itself never calls `checks.*`
// (the check-run callback is `RunWorkflow`/runtime plumbing, not run logic —
// see runs/offload-test.ts), so a dying `Checks` does not break the V0 run.
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4 (scope) + § PR6.

import { Effect, Layer } from "effect";
import {
  Browser,
  type BrowserService,
  Cache,
  type CacheService,
  Checks,
  type ChecksService,
  Config,
  type ConfigService,
} from "@flare-dispatch/core";

/** Browser — Browser Rendering binding deferred to V2. */
export const BrowserDeferred: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newPage: () => Effect.die("browser.newPage: not implemented in V0"),
    newCDPSession: () =>
      Effect.die("browser.newCDPSession: not implemented in V0"),
  }))(),
);

/** Cache — R2 cache restore/save deferred to V1. */
export const CacheDeferred: Layer.Layer<Cache> = Layer.succeed(
  Cache,
  ((): CacheService => ({
    restoreOr: () => Effect.die("cache.restoreOr: not implemented in V0"),
    save: () => Effect.die("cache.save: not implemented in V0"),
  }))(),
);

/** Config — `CONFIG_KV` binding deferred past V0. */
export const ConfigDeferred: Layer.Layer<Config> = Layer.succeed(
  Config,
  ((): ConfigService => ({
    get: () => Effect.die("config.get: not implemented in V0"),
    getJSON: () => Effect.die("config.getJSON: not implemented in V0"),
  }))(),
);

/** Checks — GitHub App check-run binding lands in PR6 (`ChecksGithubLive`). */
export const ChecksDeferred: Layer.Layer<Checks> = Layer.succeed(
  Checks,
  ((): ChecksService => ({
    create: () =>
      Effect.die("checks.create: live binding lands in PR6 (github-app)"),
    update: () =>
      Effect.die("checks.update: live binding lands in PR6 (github-app)"),
  }))(),
);
