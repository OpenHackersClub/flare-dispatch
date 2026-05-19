// Primitive: loadSecrets — pull named secrets from `config` into an env record
//
// The "inject secrets into the container" preamble of any run whose command
// needs credentials (a Clerk key, a Cloudflare API token, …). Rather than
// thread secrets through GHA repo secrets and the dispatch body, the operator
// stores them once in the FlareDispatch config store (KV); a run names the
// keys it needs and `loadSecrets` resolves them into the `Record<string,string>`
// that `sandbox.exec({ env })` / `bootApp` expect.
//
// Every read degrades gracefully (see specs/03-dsl.md § config): an unset key
// is omitted from the result and logged at `warn`, never an Effect failure —
// so a misconfigured deploy surfaces in the run log instead of crashing the
// container boot. A run that requires a secret should assert on the returned
// record itself.
//
// Rides on the `config` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { config } from "../services/config";
import { io } from "../services/io";

export const loadSecrets = (
  keys: readonly string[],
  opts: {
    /**
     * Prefix prepended to each `key` to form the config-store key — lets an
     * operator namespace secrets (e.g. `secret/`) apart from feature flags.
     * The returned record is keyed by the bare `key` (the env var name), so
     * `loadSecrets(["CLERK_SECRET_KEY"], { prefix: "secret/" })` reads
     * `secret/CLERK_SECRET_KEY` and yields `{ CLERK_SECRET_KEY: "..." }`.
     */
    prefix?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const prefix = opts.prefix ?? "";
    const env: Record<string, string> = {};
    for (const key of keys) {
      const value = yield* config.get(`${prefix}${key}`);
      if (value === undefined) {
        yield* io.log("warn", `loadSecrets: config key "${prefix}${key}" is unset`);
        continue;
      }
      env[key] = value;
    }
    return env;
  });
