// Diff noise-stripping unit tests.

import { describe, expect, it } from "vitest";
import { stripDiffNoise } from "./diff.js";

const section = (path: string, line = "+x"): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    line,
  ].join("\n");

describe("stripDiffNoise", () => {
  it("keeps source sections", () => {
    const diff = section("src/app.ts");
    expect(stripDiffNoise(diff)).toContain("src/app.ts");
  });

  it("drops lockfiles", () => {
    const diff = [section("src/app.ts"), section("pnpm-lock.yaml")].join("\n");
    const out = stripDiffNoise(diff);
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("pnpm-lock.yaml");
  });

  it("drops minified bundles and generated/vendored trees", () => {
    const diff = [
      section("src/app.ts"),
      section("public/bundle.min.js"),
      section("dist/index.js"),
      section("vendor/lib.ts"),
    ].join("\n");
    const out = stripDiffNoise(diff);
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("bundle.min.js");
    expect(out).not.toContain("dist/index.js");
    expect(out).not.toContain("vendor/lib.ts");
  });

  it("returns an empty diff unchanged", () => {
    expect(stripDiffNoise("")).toBe("");
  });
});
