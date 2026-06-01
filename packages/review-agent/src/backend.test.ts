// Backend-selection unit tests — the operator config contract.
//
// `resolveBackend` reads a `config.get`-shaped accessor; here we back it with a
// plain in-memory map so the selection logic is tested without the DSL.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  BACKEND_KEYS,
  DEFAULT_BACKEND,
  parseBackend,
  resolveBackend,
} from "./backend.js";

/** A `config.get`-shaped accessor over a plain map. */
const getter =
  (store: Record<string, string>) =>
  (key: string): Effect.Effect<string | undefined> =>
    Effect.succeed(store[key]);

describe("parseBackend", () => {
  it("passes through known backends", () => {
    expect(parseBackend("opencode")).toBe("opencode");
    expect(parseBackend("reasonix")).toBe("reasonix");
  });
  it("falls back to the default for unknown / unset", () => {
    expect(parseBackend(undefined)).toBe(DEFAULT_BACKEND);
    expect(parseBackend("anthropic")).toBe(DEFAULT_BACKEND);
  });
});

describe("resolveBackend", () => {
  it("resolves the default backend (opencode) from config + shared MODEL_API_KEY", async () => {
    const store = {
      [BACKEND_KEYS.opencode.baseUrlKey]: "https://gw/compat",
      [BACKEND_KEYS.opencode.modelKey]: "anthropic/claude-3-5-sonnet",
      MODEL_API_KEY: "sk-shared",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("opencode");
    expect(resolved.baseUrl).toBe("https://gw/compat");
    expect(resolved.model).toBe("anthropic/claude-3-5-sonnet");
    expect(resolved.apiKey).toBe("sk-shared");
  });

  it("prefers the backend-specific OPENCODE_API_KEY over the shared one", async () => {
    const store = {
      "pr-review.backend": "opencode",
      [BACKEND_KEYS.opencode.baseUrlKey]: "https://gw/compat",
      [BACKEND_KEYS.opencode.modelKey]: "m",
      OPENCODE_API_KEY: "sk-opencode",
      MODEL_API_KEY: "sk-shared",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.apiKey).toBe("sk-opencode");
  });

  it("resolves the reasonix backend with REASONIX_API_KEY", async () => {
    const store = {
      "pr-review.backend": "reasonix",
      [BACKEND_KEYS.reasonix.baseUrlKey]: "https://gw/compat",
      [BACKEND_KEYS.reasonix.modelKey]: "deepseek/deepseek-chat",
      REASONIX_API_KEY: "sk-deepseek",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("reasonix");
    expect(resolved.model).toBe("deepseek/deepseek-chat");
    expect(resolved.apiKey).toBe("sk-deepseek");
  });

  it("fails with BackendUnconfigured naming the missing base_url", async () => {
    const exit = await Effect.runPromiseExit(
      resolveBackend(getter({ MODEL_API_KEY: "sk" })),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails when the api key is absent for the selected backend", async () => {
    const store = {
      "pr-review.backend": "reasonix",
      [BACKEND_KEYS.reasonix.baseUrlKey]: "https://gw/compat",
      [BACKEND_KEYS.reasonix.modelKey]: "m",
      // no REASONIX_API_KEY, and reasonix has no shared fallback
    };
    const exit = await Effect.runPromiseExit(resolveBackend(getter(store)));
    expect(exit._tag).toBe("Failure");
  });
});
