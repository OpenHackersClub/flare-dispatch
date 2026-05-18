// @flare-dispatch/runtime-cf — IOLive: the live `io` capability.
//
// Backs `IOService` with the Workers platform primitives: `Date.now()` for the
// clock, `globalThis.crypto.randomUUID()` for UUIDs, `console` for structured
// logs. The DSL forces non-determinism through `io.*` precisely so the live
// runtime can supply these here and the test runtime can supply a deterministic
// fake — Workflow checkpoint replay then stays consistent (specs/03-dsl.md
// § io, specs/pm/plan.md § 6 "Run replay determinism").
//
// `io.env` and `io.priorExecution` are not on the V0 path (`offload-test` uses
// only `io.now` indirectly via the exec step result). They are implemented as
// honest no-ops / `Option.none()` rather than `Effect.die` so the live runtime
// is a complete `IOService` — a run that reads them degrades gracefully.
//
// Spec: specs/03-dsl.md § io, specs/pm/plan.md § PR4.

import { Duration, Effect, Layer, Option } from "effect";
import { IO, type IOService } from "@flare-dispatch/core";

/** Build the live `IO` Layer. No bindings required — pure platform globals. */
export const makeIOLive = (): Layer.Layer<IO> =>
  Layer.succeed(IO, {
    now: Effect.sync(() => Date.now()),

    // `crypto` is a Workers runtime global (WebCrypto) — the standard
    // replay-safe UUID source the DSL routes `io.uuid` through.
    uuid: Effect.sync(() => crypto.randomUUID()),

    // V0 runs are dispatched with explicit inputs, not env reads — there is no
    // per-run env surface yet. Honest `undefined` keeps `io.env` total.
    env: () => Effect.succeed(undefined),

    // `Duration.decode` normalises the IOService input to a `Duration`. The
    // interface types the input as a plain `string`; Effect's `DurationInput`
    // is the narrower `` `${number} ${unit}` `` template — the cast asserts
    // the documented contract (a duration-shaped string).
    sleep: (d) => Effect.sleep(Duration.decode(d as Duration.DurationInput)),

    log: (level, msg, attrs) =>
      Effect.sync(() => {
        const line = { level, msg, ...(attrs ?? {}) };
        // Workers logs are JSON-lines on stdout; `console` is the platform sink.
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
      }),

    // `io.priorExecution` reads prior D1 execution metadata — deferred past V0
    // (no run on the V0 path consumes it). `Option.none()` is the documented
    // "first execution of a family" result, so this stays a total, non-failing
    // capability rather than an `Effect.die`.
    priorExecution: () => Effect.succeed(Option.none()),
  } satisfies IOService);

/** The live `IO` Layer — platform `crypto` + `Date`. */
export const IOLive: Layer.Layer<IO> = makeIOLive();
