// Tests for `defineRun` — load-time spec validation (kebab-case name, semver
// version, positive maxDurationSec). A malformed spec throws at construction.

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineRun } from "./define-run";

const validSpec = {
  name: "offload-test",
  version: "1.0.0",
  inputs: Schema.Struct({ repo: Schema.String }),
  outputs: Schema.Struct({ exitCode: Schema.Number }),
  limits: { maxDurationSec: 1800 },
  run: () => Effect.succeed({ exitCode: 0 }),
} as const;

describe("defineRun", () => {
  it("constructs a Run from a valid spec", () => {
    const run = defineRun(validSpec);
    expect(run._tag).toBe("Run");
    expect(run.name).toBe("offload-test");
    expect(run.version).toBe("1.0.0");
  });

  it("accepts a single-segment kebab name", () => {
    expect(() => defineRun({ ...validSpec, name: "smoke" })).not.toThrow();
  });

  it("accepts a semver pre-release version", () => {
    expect(() =>
      defineRun({ ...validSpec, version: "2.0.0-rc.1" }),
    ).not.toThrow();
  });

  it.each([
    ["OffloadTest", "uppercase"],
    ["offload_test", "underscore"],
    ["offload-test-", "trailing hyphen"],
    ["-offload", "leading hyphen"],
    ["offload--test", "double hyphen"],
    ["", "empty"],
  ])("rejects non-kebab name %j (%s)", (name) => {
    expect(() => defineRun({ ...validSpec, name })).toThrow(/kebab-case/);
  });

  it.each([
    ["1.0", "two segments"],
    ["1", "one segment"],
    ["v1.0.0", "v-prefixed"],
    ["1.0.0.0", "four segments"],
    ["latest", "non-numeric"],
  ])("rejects non-semver version %j (%s)", (version) => {
    expect(() => defineRun({ ...validSpec, version })).toThrow(/semver/);
  });

  it.each([
    [0, "zero"],
    [-1, "negative"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ])("rejects non-positive maxDurationSec %j (%s)", (maxDurationSec) => {
    expect(() =>
      defineRun({ ...validSpec, limits: { maxDurationSec } }),
    ).toThrow(/maxDurationSec/);
  });
});
