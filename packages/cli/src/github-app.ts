// FlareDispatch CLI — `github-app create` subcommand.
//
// A thin launcher that constructs `<endpoint>/v1/github/install/new` and
// surfaces the URL to the operator. The whole interactive flow (manifest form,
// GitHub round-trip, credential display) lives in the Dispatcher (apps/
// dispatcher/src/routes/github.ts) — the CLI exists so the operator does not
// have to remember the path or paste it into a browser by hand.
//
// Design decisions:
//
//   * Endpoint validation reuses the same scheme/URL rules as the `dispatch`
//     subcommand — `file://`, `data:`, `ftp:` etc. are rejected before we even
//     print a URL the operator might click on (security review M1 from
//     dispatch). The validator is factored into a small helper rather than
//     duplicated.
//
//   * `open <url>` (macOS) / `xdg-open <url>` (Linux) is best-effort. A
//     headless agent, a missing `open` binary, or a non-interactive shell all
//     just print the URL and continue — the CLI never exits non-zero because
//     of a browser-launch failure.
//
//   * No blocking on the browser. The user might run the wrangler commands
//     hours later; the CLI returns immediately.
//
// Spec: specs/05-byoc.md § GitHub App setup + § CLI.

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { Console, Effect, Match } from "effect";
import { InvalidEndpoint, MissingInput } from "./errors.js";

/**
 * Validate that `endpoint` parses as an `http:` or `https:` URL. Returns the
 * trimmed-of-trailing-slash form on success; a tagged `InvalidEndpoint`
 * otherwise. Mirrors the validation `dispatch.ts` runs against
 * `INPUT_ENDPOINT`, but factored so both call sites share the rule.
 */
export const validateEndpoint = (
  endpoint: string,
): Effect.Effect<string, InvalidEndpoint> =>
  Effect.gen(function* () {
    const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    const parsed = yield* Effect.try({
      try: () => new URL(trimmed),
      catch: (cause) =>
        new InvalidEndpoint({
          endpoint: trimmed,
          reason:
            cause instanceof Error
              ? `not a valid URL: ${cause.message}`
              : "not a valid URL",
        }),
    });
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return yield* Effect.fail(
        new InvalidEndpoint({
          endpoint: trimmed,
          reason: `unsupported scheme ${parsed.protocol} — only http(s) allowed`,
        }),
      );
    }
    return trimmed;
  });

/**
 * Try to launch the system default browser for `url`. Resolves to `true` if
 * the launch was attempted (which is all we can confirm without blocking on
 * the browser process), `false` if there's no way to launch on this platform.
 *
 * We use `spawn(...).unref()` so the CLI process can exit immediately after
 * printing — without `unref()`, the parent stays alive until the browser
 * closes, which is the opposite of what we want.
 */
const tryOpenBrowser = (url: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const p = platform();
    const launcher = Match.value(p).pipe(
      Match.when("darwin", () => ({ cmd: "open", args: [url] })),
      Match.when("win32", () => ({ cmd: "cmd", args: ["/c", "start", "", url] })),
      Match.orElse(() => ({ cmd: "xdg-open", args: [url] })),
    );
    try {
      const child = spawn(launcher.cmd, launcher.args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {
        // Swallow — we'll surface the URL via the printed instructions.
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  });

export interface GithubAppCreateOptions {
  /** Already-validated endpoint (no trailing slash, http(s) only). */
  readonly endpoint: string;
}

/**
 * Print the install URL and try to open it. Never fails — a browser-launch
 * failure is reported on stderr and we still exit zero.
 */
export const runGithubAppCreate = (
  opts: GithubAppCreateOptions,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const url = `${opts.endpoint}/v1/github/install/new`;
    yield* Console.log(
      "FlareDispatch: open this URL in your browser to create the GitHub App —\n",
    );
    yield* Console.log(`  ${url}\n`);
    yield* Console.log(
      "After GitHub redirects you back, the Dispatcher will display the App's",
    );
    yield* Console.log(
      "credentials with the `wrangler secret put` commands you need to run.\n",
    );

    const launched = yield* tryOpenBrowser(url);
    if (!launched) {
      yield* Console.log(
        "(could not auto-launch a browser on this platform — copy the URL above)",
      );
    }
  });

/**
 * Resolve `--endpoint` from the parsed CLI option, validate it, and run the
 * launcher. Surfaces the same `InvalidEndpoint` / `MissingInput` tagged
 * errors the dispatch path uses so the failure-reporter behaves the same way.
 */
export const runGithubAppCreateFromOption = (
  endpoint: string | undefined,
): Effect.Effect<void, InvalidEndpoint | MissingInput> =>
  Effect.gen(function* () {
    if (endpoint === undefined || endpoint === "") {
      return yield* Effect.fail(new MissingInput({ name: "endpoint" }));
    }
    const validated = yield* validateEndpoint(endpoint);
    yield* runGithubAppCreate({ endpoint: validated });
  });
