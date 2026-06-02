// Catalog-level guard for `sandboxImage` assignments across the run set.
//
// The split exists because two different things both get called "browser":
//   - CF Browser Rendering over CDP (`limits.requiresBrowser`) — the run
//     connects *out* to a CF-managed browser; needs NO in-image chromium, so it
//     stays on the LEAN image.
//   - Playwright's own chromium launched *inside* the sandbox — needs the
//     chromium-baked image, declared `sandboxImage: "browser"`.
//
// Getting these crossed would either bloat every run with a browser it never
// uses, or route an in-sandbox Playwright run to an image with no browser.
//
// These assertions derive from the WHOLE catalog (every run exported from
// `./index`) rather than a hand-maintained list, so a newly added run is
// guarded the moment it ships — a new run that wrongly sets `"browser"`, or a
// new CDP run, can't slip past an out-of-date table.

import { describe, expect, it } from "vitest";
import type { Run } from "@flare-dispatch/core";
import * as catalog from "./index";

// `./index` exports run values only; surface them as the catalog under test.
const runs = Object.values(catalog) as ReadonlyArray<Run<unknown, unknown>>;

describe("sandboxImage catalog", () => {
  it("has runs to guard (the catalog import resolved)", () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(typeof r.name).toBe("string");
  });

  it("routes EXACTLY the in-sandbox-chromium run(s) to the browser image", () => {
    const onBrowserImage = runs
      .filter((r) => r.sandboxImage === "browser")
      .map((r) => r.name)
      .sort();
    // `playwright-demo` is the only run that launches Playwright's own chromium
    // inside the sandbox. If this list grows, the new run had better genuinely
    // need an in-image browser — update it deliberately, don't auto-pass.
    expect(onBrowserImage).toEqual(["playwright-demo"]);
  });

  it("never crosses the axes: a requiresBrowser (CDP) run is never on the browser image", () => {
    const crossed = runs
      .filter((r) => r.limits.requiresBrowser === true && r.sandboxImage === "browser")
      .map((r) => r.name);
    expect(crossed).toEqual([]);
  });

  it("uses only known sandboxImage values", () => {
    const unknown = runs
      .filter(
        (r) =>
          r.sandboxImage !== undefined &&
          r.sandboxImage !== "lean" &&
          r.sandboxImage !== "browser",
      )
      .map((r) => r.name);
    expect(unknown).toEqual([]);
  });
});
