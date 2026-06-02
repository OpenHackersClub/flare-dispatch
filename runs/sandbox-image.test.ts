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
// uses, or route an in-sandbox Playwright run to an image with no browser. This
// test pins the intended mapping so a future edit can't silently flip it.

import { describe, expect, it } from "vitest";
import {
  cdpAcceptance,
  deploySmoke,
  matrixFanout,
  offloadTest,
  playwrightDemo,
  playwrightE2E,
  prReview,
  productDemo,
} from "./index";

describe("sandboxImage catalog", () => {
  it("routes ONLY the in-sandbox-chromium run to the browser image", () => {
    expect(playwrightDemo.sandboxImage).toBe("browser");
  });

  it.each([
    ["offload-test", offloadTest],
    ["pr-review", prReview],
    ["deploy-smoke", deploySmoke],
    ["matrix-fanout", matrixFanout],
    // CDP / Browser Rendering runs: they reserve a CF browser slot but launch no
    // in-image browser — so they MUST stay lean.
    ["cdp-acceptance", cdpAcceptance],
    ["playwright-e2e", playwrightE2E],
    ["product-demo", productDemo],
  ])("keeps %s on the lean image", (_name, run) => {
    expect(run.sandboxImage).not.toBe("browser");
  });
});
