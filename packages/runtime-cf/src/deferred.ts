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
import {
  Browser,
  BrowserUnavailable,
  type BrowserService,
  Config,
  type ConfigService,
  Github,
  type GithubService,
  Oidc,
  OidcSigningFailed,
  type OidcService,
} from "@flare-dispatch/core";

/** Browser — Browser Rendering binding deferred to V2 (PR9). */
export const BrowserDeferred: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newPage: () =>
      Effect.fail(
        new BrowserUnavailable({
          reason: "transient",
        }),
      ),
    newCDPSession: () =>
      Effect.fail(
        new BrowserUnavailable({
          reason: "transient",
        }),
      ),
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

/**
 * Github — the fallback until a live HTTP-backed binding lands. The Tag exists
 * so a run author can write `github.openPullRequests(...)` and unit-test it
 * against the in-memory fake (`GithubFake` in `@flare-dispatch/core/testing`).
 * A live deploy that has not wired the GitHub-API caller dies loudly rather
 * than silently returning empty arrays — this surface is V3+ work, paired
 * with the `pr-review-sweep` recipe.
 */
export const GithubDeferred: Layer.Layer<Github> = Layer.succeed(
  Github,
  ((): GithubService => ({
    repositories: () =>
      Effect.die(
        "github.repositories: not implemented in this deploy — V3 capability",
      ),
    openPullRequests: () =>
      Effect.die(
        "github.openPullRequests: not implemented in this deploy — V3 capability",
      ),
    // `pullReview` is *reporting*, not correctness — a deploy without GitHub
    // App credentials degrades to a logged no-op (the same posture as the no-op
    // `Checks` Layer), never failing an otherwise-green run. The live
    // credentialed path is `makeGithubLive` (github-live.ts).
    pullReview: ({ repo, pr }) =>
      Effect.logInfo(
        `github.pullReview skipped (no GitHub App credentials) — PR comment on ${repo}#${pr} not posted`,
      ),
  }))(),
);

/**
 * Oidc — the fallback when a deploy has no `OIDC_SIGNING_JWK` secret. The
 * Tag is always supplied so a run can be tested against the
 * `OidcFake`; a live deploy without the signing key fails the run with a
 * typed `OidcSigningFailed` rather than silently signing with a missing key.
 * Wire `makeOidcRenderingLive(jwk, issuer)` when the secret is present.
 */
export const OidcDeferred: Layer.Layer<Oidc> = Layer.succeed(
  Oidc,
  ((): OidcService => ({
    sign: () =>
      Effect.fail(
        new OidcSigningFailed({
          reason: "key-load",
          cause: "OIDC_SIGNING_JWK Worker secret not set on this deploy",
        }),
      ),
    // `issuer()` returns the configured issuer URL even on a no-key deploy
    // — the URL is operational metadata, not gated on key presence.
    issuer: () => Effect.succeed("https://oidc-not-configured.local"),
  }))(),
);

