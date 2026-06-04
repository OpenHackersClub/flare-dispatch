// Unit tests for the `product-demo` run.
//
// The substantive surface this PR adds is `parseStoriesMarkdown` — a pure
// function turning a markdown demo script (one `## ` heading per story) into
// the run's `{ name, prose }[]`. It's covered exhaustively here because that's
// where the parsing bugs live; the function is pure (no runtime needed).
//
// The run-level cases cover the input RESOLUTION that sits before any
// browser/sandbox work, so they need no CDP/agent stubs:
//   (a) neither `stories` nor `storiesMarkdown` → the run Effect dies.
//   (b) `storiesMarkdown` with no `## ` heading → dies (parses to empty).
//   (c) duplicate story names → dies (names are rrweb chapter markers).
// The full play/record/summarize orchestration needs the demo-agent CLI +
// Browser Run and is exercised end-to-end on the Dispatcher, not here.

import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Match, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@flare-dispatch/core/testing";
import { productDemo, parseStoriesMarkdown } from "./product-demo";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  deployedUrl: "https://staging.example.com",
} as const;

describe("parseStoriesMarkdown", () => {
  it("turns each `## ` heading into a { name, prose } story", () => {
    const md = [
      "## sign-in",
      "Open the site and log in with the demo account.",
      "",
      "## create-project",
      "Create a project called Demo and confirm the empty-state CTA.",
    ].join("\n");

    expect(parseStoriesMarkdown(md)).toEqual([
      {
        name: "sign-in",
        prose: "Open the site and log in with the demo account.",
      },
      {
        name: "create-project",
        prose: "Create a project called Demo and confirm the empty-state CTA.",
      },
    ]);
  });

  it("ignores a `# Title` and preamble before the first `## ` heading", () => {
    const md = [
      "# Demo script",
      "",
      "Some context the agent never sees.",
      "",
      "## landing",
      "Visit the homepage; the primary CTA is above the fold.",
    ].join("\n");

    expect(parseStoriesMarkdown(md)).toEqual([
      {
        name: "landing",
        prose: "Visit the homepage; the primary CTA is above the fold.",
      },
    ]);
  });

  it("keeps deeper headings (`###`) inside the enclosing story's prose", () => {
    const md = [
      "## checkout",
      "Add an item to the cart, then:",
      "",
      "### edge case",
      "Apply an expired coupon and confirm the inline error.",
    ].join("\n");

    const stories = parseStoriesMarkdown(md);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.name).toBe("checkout");
    expect(stories[0]!.prose).toContain("### edge case");
    expect(stories[0]!.prose).toContain("expired coupon");
  });

  it("trims heading whitespace, trailing `#`, and surrounding blank lines", () => {
    const md = ["##   spaced heading  ##  ", "", "  body text  ", ""].join(
      "\n",
    );
    expect(parseStoriesMarkdown(md)).toEqual([
      { name: "spaced heading", prose: "body text" },
    ]);
  });

  it("returns [] for a doc with no `## ` headings", () => {
    expect(parseStoriesMarkdown("# Title only\n\njust prose, no stories")).toEqual(
      [],
    );
    expect(parseStoriesMarkdown("")).toEqual([]);
  });

  it("does not treat `###`+ as a story boundary", () => {
    const md = ["### not a story", "body"].join("\n");
    expect(parseStoriesMarkdown(md)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const md = "## a\r\nfirst\r\n## b\r\nsecond";
    expect(parseStoriesMarkdown(md)).toEqual([
      { name: "a", prose: "first" },
      { name: "b", prose: "second" },
    ]);
  });
});

describe("product-demo input resolution", () => {
  const expectDie = (input: Record<string, unknown>, substring: string) => {
    const { layer } = makeCFRuntimeTest();
    return Effect.gen(function* () {
      // `input` is intentionally partial (missing/invalid stories) to exercise
      // the resolution guard — cast past the decoded Input type for the test.
      const exit = yield* Effect.exit(
        productDemo.run(input as Parameters<typeof productDemo.run>[0]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(substring);
      }
    }).pipe(Effect.provide(layer));
  };

  it.effect("dies when neither `stories` nor `storiesMarkdown` is given", () =>
    expectDie(baseInput, "no stories to play"),
  );

  it.effect("dies when `storiesMarkdown` has no `## ` heading", () =>
    expectDie(
      { ...baseInput, storiesMarkdown: "# Title\n\nno stories here" },
      "no stories to play",
    ),
  );

  it.effect("dies on duplicate story names", () =>
    expectDie(
      {
        ...baseInput,
        stories: [
          { name: "dup", prose: "first" },
          { name: "dup", prose: "second" },
        ],
      },
      "duplicate story names",
    ),
  );
});

describe("product-demo honest check (issue #85)", () => {
  it.effect(
    "fails with AcceptanceFailed CARRYING the per-chapter summaryMd when no story passes",
    () => {
      const { layer } = makeCFRuntimeTest({
        // Seed the secrets `loadSecrets({ required: true })` resolves + the
        // mandatory play model — the run dies before any story otherwise.
        config: {
          "product-demo.secret/CF_AI_GATEWAY_ID": "gw",
          "product-demo.secret/CLOUDFLARE_ACCOUNT_ID": "acct",
          "product-demo.secret/CLOUDFLARE_API_TOKEN": "tok",
          "product-demo.model.play": "claude-opus-4-7",
        },
        // The sentinel poll reads `DONE:1` on its first `cat` (the detached
        // play exited non-zero); the play's stdout stays empty, so the parse
        // fallback marks the story failed → passedCount === 0 → honest fail.
        sandboxProgram: { ".done": { exitCode: 0, stdout: "DONE:1" } },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          productDemo.run({
            ...baseInput,
            stories: [{ name: "landing", prose: "Visit the homepage." }],
          } as Parameters<typeof productDemo.run>[0]),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        const summaryMd = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onNone: () => undefined,
              onSome: (failure) =>
                Match.value(failure).pipe(
                  Match.tag("AcceptanceFailed", (e) => e.summaryMd),
                  Match.orElse(() => undefined),
                ),
            })
          : undefined;

        // The typed failure carries the SAME chapter table a green run
        // returns as output — the dispatcher embeds it in the red check-run.
        expect(summaryMd).toBeDefined();
        expect(summaryMd).toContain("0/1 chapters passed");
        expect(summaryMd).toContain("| landing |");
        expect(summaryMd).toContain("❌ fail");
      }).pipe(Effect.provide(layer));
    },
  );
});
