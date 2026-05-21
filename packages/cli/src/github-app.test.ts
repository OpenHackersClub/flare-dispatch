// Tests for the `github-app create` flow.
//
// Exercises the pure parts (`validateEndpoint`, URL construction in
// `runGithubAppCreate`) by capturing stdout. The browser-launch path is left
// uncovered — `spawn(...).unref()` is a fire-and-forget side effect with no
// observable return; there's nothing meaningful to assert that wouldn't be
// a brittle test of the host environment's `open`/`xdg-open` binary.

import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  runGithubAppCreate,
  runGithubAppCreateFromOption,
  validateEndpoint,
} from "./github-app.js";

// ---------------------------------------------------------------------------
// validateEndpoint — the shared scheme/URL rule. Same fixtures as `dispatch`.
// ---------------------------------------------------------------------------

describe("validateEndpoint", () => {
  it("accepts https://", async () => {
    const result = await Effect.runPromise(
      validateEndpoint("https://flare-dispatch.example.com"),
    );
    expect(result).toBe("https://flare-dispatch.example.com");
  });

  it("accepts http:// (wrangler dev)", async () => {
    const result = await Effect.runPromise(
      validateEndpoint("http://127.0.0.1:8787"),
    );
    expect(result).toBe("http://127.0.0.1:8787");
  });

  it("strips a single trailing slash", async () => {
    const result = await Effect.runPromise(
      validateEndpoint("https://x.example/"),
    );
    expect(result).toBe("https://x.example");
  });

  it("rejects file:// with InvalidEndpoint", async () => {
    const exit = await Effect.runPromiseExit(
      validateEndpoint("file:///etc/passwd"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("InvalidEndpoint");
      expect(pretty).toContain("file:");
    }
  });

  it("rejects data: with InvalidEndpoint", async () => {
    const exit = await Effect.runPromiseExit(
      validateEndpoint("data:text/plain,hello"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("InvalidEndpoint");
    }
  });

  it("rejects ftp:// with InvalidEndpoint", async () => {
    const exit = await Effect.runPromiseExit(
      validateEndpoint("ftp://files.example.com/"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("InvalidEndpoint");
    }
  });

  it("rejects a malformed URL with InvalidEndpoint", async () => {
    const exit = await Effect.runPromiseExit(validateEndpoint("not a url"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("InvalidEndpoint");
    }
  });
});

// ---------------------------------------------------------------------------
// runGithubAppCreate — the launcher. Capture stdout to assert the URL line.
// ---------------------------------------------------------------------------

const captureStdout = async (
  effect: Effect.Effect<void>,
): Promise<string[]> => {
  const captured: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    captured.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await Effect.runPromise(effect);
  } finally {
    spy.mockRestore();
  }
  return captured;
};

describe("runGithubAppCreate", () => {
  it("prints the install URL with /v1/github/install/new appended", async () => {
    const lines = await captureStdout(
      runGithubAppCreate({ endpoint: "https://x.example" }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("https://x.example/v1/github/install/new");
    expect(joined).toContain(
      "After GitHub redirects you back",
    );
  });

  it("doesn't double-append /v1/github/install/new when given an already-stripped endpoint", async () => {
    const lines = await captureStdout(
      runGithubAppCreate({ endpoint: "https://x.example" }),
    );
    const joined = lines.join("\n");
    expect(joined).not.toContain(
      "/v1/github/install/new/v1/github/install/new",
    );
  });
});

// ---------------------------------------------------------------------------
// runGithubAppCreateFromOption — what the @effect/cli subcommand calls.
// ---------------------------------------------------------------------------

describe("runGithubAppCreateFromOption", () => {
  it("validates + prints for https://", async () => {
    const lines = await captureStdout(
      runGithubAppCreateFromOption("https://x.example").pipe(
        Effect.catchAll(() => Effect.die("unexpected failure")),
      ),
    );
    expect(lines.join("\n")).toContain(
      "https://x.example/v1/github/install/new",
    );
  });

  it("fails with InvalidEndpoint for file://", async () => {
    const exit = await Effect.runPromiseExit(
      runGithubAppCreateFromOption("file:///etc/passwd"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("InvalidEndpoint");
      expect(pretty).toContain("file:");
    }
  });

  it("fails with MissingInput when endpoint is undefined", async () => {
    const exit = await Effect.runPromiseExit(
      runGithubAppCreateFromOption(undefined),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("MissingInput");
      expect(pretty).toContain("endpoint");
    }
  });

  it("fails with MissingInput when endpoint is empty", async () => {
    const exit = await Effect.runPromiseExit(
      runGithubAppCreateFromOption(""),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("MissingInput");
    }
  });

  it("strips a trailing slash from the endpoint before composing the URL", async () => {
    const lines = await captureStdout(
      runGithubAppCreateFromOption("https://x.example/").pipe(
        Effect.catchAll(() => Effect.die("unexpected failure")),
      ),
    );
    const joined = lines.join("\n");
    // We DON'T want `https://x.example//v1/github/install/new`.
    expect(joined).toContain("https://x.example/v1/github/install/new");
    expect(joined).not.toContain("https://x.example//");
  });
});
