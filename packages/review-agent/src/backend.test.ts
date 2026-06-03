// Backend-selection unit tests — the operator config contract.
//
// `resolveBackend` reads a `config.get`-shaped accessor; here we back it with a
// plain in-memory map so the selection logic is tested without the DSL. No API
// key is read — the Workers AI binding (the `modelGateway` backend) is the auth.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  BACKEND_KEYS,
  DEFAULT_BACKEND,
  backendConfigKey,
  namespacedKeys,
  parseBackend,
  parseMode,
  promptKey,
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

describe("parseMode", () => {
  it("passes through known modes", () => {
    expect(parseMode("tools", "json")).toBe("tools");
    expect(parseMode("json", "tools")).toBe("json");
  });
  it("falls back to the supplied default for unknown / unset", () => {
    expect(parseMode(undefined, "json")).toBe("json");
    expect(parseMode("structured", "tools")).toBe("tools");
  });
});

describe("resolveBackend", () => {
  it("resolves the default backend (opencode) from config — no API key", async () => {
    const store = {
      [BACKEND_KEYS.opencode.modelKey]:
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("opencode");
    expect(resolved.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // opencode defaults to the tool-calling path.
    expect(resolved.mode).toBe("tools");
  });

  it("resolves the reasonix backend", async () => {
    const store = {
      "pr-review.backend": "reasonix",
      [BACKEND_KEYS.reasonix.modelKey]:
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("reasonix");
    expect(resolved.model).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
    // reasonix defaults to json mode (DeepSeek doesn't honour tool-calls).
    expect(resolved.mode).toBe("json");
  });

  it("honours an explicit per-backend mode override", async () => {
    const store = {
      "pr-review.backend": "reasonix",
      [BACKEND_KEYS.reasonix.modelKey]: "m",
      [BACKEND_KEYS.reasonix.modeKey]: "tools",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.mode).toBe("tools");
  });

  it("falls back to the backend default for an unrecognized mode value", async () => {
    const store = {
      "pr-review.backend": "opencode",
      [BACKEND_KEYS.opencode.modelKey]: "m",
      [BACKEND_KEYS.opencode.modeKey]: "structured",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.mode).toBe("tools");
  });

  it("fails with BackendUnconfigured naming the missing model key", async () => {
    const exit = await Effect.runPromiseExit(resolveBackend(getter({})));
    expect(exit._tag).toBe("Failure");
  });
});

describe("namespaced config (downstream recipe reuse)", () => {
  it("derives per-namespace keys without colliding with pr-review", () => {
    expect(backendConfigKey("spec-drift")).toBe("spec-drift.backend");
    expect(promptKey("spec-drift")).toBe("spec-drift.prompt");
    expect(namespacedKeys("ci-triage").opencode.modelKey).toBe(
      "ci-triage.opencode.model",
    );
    // The default namespace's keys are unchanged (pr-review compatibility).
    expect(BACKEND_KEYS.opencode.modelKey).toBe("pr-review.opencode.model");
  });

  it("resolveBackend reads the given namespace's keys", async () => {
    const store = {
      "spec-drift.backend": "reasonix",
      "spec-drift.reasonix.model": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      // A pr-review key must NOT leak into the spec-drift resolution.
      "pr-review.opencode.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
    const resolved = await Effect.runPromise(
      resolveBackend(getter(store), { namespace: "spec-drift" }),
    );
    expect(resolved.backend).toBe("reasonix");
    expect(resolved.model).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
    expect(resolved.mode).toBe("json");
  });
});
