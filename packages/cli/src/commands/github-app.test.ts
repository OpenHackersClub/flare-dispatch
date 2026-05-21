// Unit test for the github-app subcommand URL builder.
//
// The CLI's only meaningful work is composing the start URL. Run `tsx
// src/main.ts github-app create --endpoint <url>` and you get a printed URL;
// every shape concern lives in `buildStartUrl`, which is a pure function and
// is what we test here. The Effect+platform-node bootstrap in `main.ts` is
// exercised by running the binary directly during dev — wiring it through
// vitest doesn't catch any additional bugs.

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { buildStartUrl } from "./github-app";

describe("buildStartUrl", () => {
  it("appends /v1/github/start with no query when org is None", () => {
    expect(
      buildStartUrl(
        "https://flare-dispatch-v0.acme.workers.dev",
        Option.none(),
      ),
    ).toBe("https://flare-dispatch-v0.acme.workers.dev/v1/github/start");
  });

  it("appends ?org=<slug> when org is Some", () => {
    expect(
      buildStartUrl(
        "https://flare-dispatch-v0.acme.workers.dev",
        Option.some("OpenHackersClub"),
      ),
    ).toBe(
      "https://flare-dispatch-v0.acme.workers.dev/v1/github/start?org=OpenHackersClub",
    );
  });

  it("strips trailing slashes from the endpoint so paths don't double-up", () => {
    expect(
      buildStartUrl("https://example.com/", Option.none()),
    ).toBe("https://example.com/v1/github/start");
    expect(
      buildStartUrl("https://example.com///", Option.some("X")),
    ).toBe("https://example.com/v1/github/start?org=X");
  });

  it("percent-encodes weird (but technically legal) org slugs", () => {
    // GitHub's slug grammar doesn't allow these, but the Worker rejects them
    // upstream — encoding here keeps the URL well-formed regardless.
    expect(
      buildStartUrl("https://x", Option.some("a b")),
    ).toBe("https://x/v1/github/start?org=a%20b");
  });
});
