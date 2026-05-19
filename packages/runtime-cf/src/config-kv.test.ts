// Integration tests for ConfigKvLive — the live `config` capability.
//
// Drives the real KV binding via Miniflare. Asserts `get` reads stored values
// and degrades unset keys to `undefined`, and that `getJSON` decodes against a
// Schema while collapsing every failure mode (unset, malformed JSON, Schema
// mismatch) to `Option.none()`.

import { Effect, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Config } from "@flare-dispatch/core";
import { makeConfigKvLive } from "./config-kv";
import { makeTestBindings, type TestBindings } from "./test-support";

const Flags = Schema.Struct({ beta: Schema.Boolean });

describe("ConfigKvLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  /** Run an effect against a live `Config` Layer over the Miniflare KV. */
  const run = <A>(effect: Effect.Effect<A, never, Config>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provide(makeConfigKvLive(bindings.kv))),
    );

  it("get returns the stored string value", async () => {
    await bindings.kv.put("model", "claude-opus-4-7");
    const value = await run(Effect.flatMap(Config, (c) => c.get("model")));
    expect(value).toBe("claude-opus-4-7");
  });

  it("get returns undefined for an unset key", async () => {
    const value = await run(Effect.flatMap(Config, (c) => c.get("absent")));
    expect(value).toBeUndefined();
  });

  it("getJSON decodes a stored value against the schema", async () => {
    await bindings.kv.put("flags", JSON.stringify({ beta: true }));
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.getOrNull(value)).toEqual({ beta: true });
  });

  it("getJSON is none for an unset key", async () => {
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("absent", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("getJSON is none for malformed JSON", async () => {
    await bindings.kv.put("flags", "{not json");
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("getJSON is none when the value fails schema validation", async () => {
    await bindings.kv.put("flags", JSON.stringify({ beta: "yes" }));
    const value = await run(
      Effect.flatMap(Config, (c) => c.getJSON("flags", Flags)),
    );
    expect(Option.isNone(value)).toBe(true);
  });
});
