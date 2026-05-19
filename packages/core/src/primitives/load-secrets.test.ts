// Unit tests for the `loadSecrets` primitive.
//
// Drives `loadSecrets` against an in-memory `Config` Layer + the IO fake:
// present keys land in the env record, unset keys are omitted and logged at
// `warn`, and the optional prefix namespaces the config lookup without
// leaking into the env var name.

import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Config, type ConfigService } from "../services/config";
import { makeIOFake } from "../testing";
import { loadSecrets } from "./load-secrets";

/** A `Config` Layer whose `get` reads from a plain in-memory store. */
const configLayer = (store: Record<string, string>): Layer.Layer<Config> =>
  Layer.succeed(Config, {
    get: (key) => Effect.succeed(store[key]),
    getJSON: () => Effect.succeed(Option.none()),
  } satisfies ConfigService);

/** Run `loadSecrets` against `store`, returning the env record + the IO logs. */
const runLoad = async (
  keys: readonly string[],
  store: Record<string, string>,
  opts?: { prefix?: string },
) => {
  const io = makeIOFake();
  const env = await Effect.runPromise(
    loadSecrets(keys, opts).pipe(
      Effect.provide(Layer.merge(configLayer(store), io.layer)),
    ),
  );
  return { env, logs: io.state.logs };
};

describe("loadSecrets", () => {
  it("resolves present keys into an env record", async () => {
    const { env } = await runLoad(["CLERK_SECRET_KEY", "CF_API_TOKEN"], {
      CLERK_SECRET_KEY: "sk_test_x",
      CF_API_TOKEN: "tok_y",
    });
    expect(env).toEqual({
      CLERK_SECRET_KEY: "sk_test_x",
      CF_API_TOKEN: "tok_y",
    });
  });

  it("omits an unset key and logs it at warn instead of failing", async () => {
    const { env, logs } = await runLoad(["PRESENT", "MISSING"], {
      PRESENT: "v",
    });
    expect(env).toEqual({ PRESENT: "v" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.msg).toContain("MISSING");
  });

  it("applies the prefix to the config lookup, not the env var name", async () => {
    const { env } = await runLoad(
      ["CLERK_SECRET_KEY"],
      { "secret/CLERK_SECRET_KEY": "sk_live" },
      { prefix: "secret/" },
    );
    expect(env).toEqual({ CLERK_SECRET_KEY: "sk_live" });
  });

  it("returns an empty record for no keys", async () => {
    const { env, logs } = await runLoad([], {});
    expect(env).toEqual({});
    expect(logs).toHaveLength(0);
  });
});
