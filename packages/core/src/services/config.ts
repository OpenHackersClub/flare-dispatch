// @flare-dispatch/core — the `config` capability (read-only dynamic config).
//
// KV-backed model routing, provider switches, feature flags. Edits propagate
// to subsequent executions within seconds, no redeploy. Every failure mode
// degrades gracefully — an unset key is `undefined`, a malformed JSON value is
// `Option.none()` — so a run that reads config MUST carry a sensible default.
//
// Spec: specs/03-dsl.md § config.

import { Context, Effect, type Option, type Schema } from "effect";

export interface ConfigService {
  readonly get: (key: string) => Effect.Effect<string | undefined>;
  readonly getJSON: <A>(
    key: string,
    schema: Schema.Schema<A, unknown>,
  ) => Effect.Effect<Option.Option<A>>;
}

export class Config extends Context.Tag("@flare-dispatch/core/Config")<
  Config,
  ConfigService
>() {}

export const config = {
  get: (key: string) => Effect.flatMap(Config, (c) => c.get(key)),
  getJSON: <A>(key: string, schema: Schema.Schema<A, unknown>) =>
    Effect.flatMap(Config, (c) => c.getJSON(key, schema)),
} as const;
