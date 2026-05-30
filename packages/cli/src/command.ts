// FlareDispatch CLI — `@effect/cli` subcommand definitions.
//
// Split out from `dispatch.ts` so that the JS-Action entry can import the
// dispatch flow without pulling `@effect/cli` into the bundle. The standalone
// `flare-dispatch` binary (`main.ts`) is the only consumer of this file.

import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { Console, Effect, Match } from "effect";
import {
  type DispatchEnv,
  reportFailure,
  runDispatch,
} from "./dispatch.js";
import { InvalidEndpoint, MissingInput } from "./errors.js";
import { runGithubAppCreateFromOption } from "./github-app.js";

/**
 * The `dispatch` subcommand. Takes no flags — every input is an env var,
 * matching the GHA Action contract.
 */
export const dispatchCommand = Command.make("dispatch", {}, () =>
  runDispatch({ env: process.env as DispatchEnv }).pipe(
    Effect.asVoid,
    Effect.catchAll(reportFailure),
  ),
);

/**
 * Render a `MissingInput` / `InvalidEndpoint` from the `github-app create`
 * flow as a plain stderr line + non-zero exit. (The GHA-style `::error::`
 * format is only useful inside a GitHub Actions runner; the `flare-dispatch`
 * binary is invoked interactively by humans, so plain prose + non-zero exit
 * is the right shape here.)
 */
const reportGithubAppFailure = (
  e: MissingInput | InvalidEndpoint,
): Effect.Effect<never, never, never> =>
  Match.value(e).pipe(
    Match.tag("MissingInput", ({ name }) =>
      Effect.gen(function* () {
        yield* Console.error(`error: '--${name}' is required`);
        return yield* Effect.die(e);
      }),
    ),
    Match.tag("InvalidEndpoint", ({ endpoint, reason }) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: '--endpoint' is invalid (${reason}): ${endpoint}`,
        );
        return yield* Effect.die(e);
      }),
    ),
    Match.exhaustive,
  );

/**
 * The `github-app create` subcommand — opens the manifest-creation flow on a
 * deployed Dispatcher. Sits under a `github-app` group so future commands
 * (`github-app delete`, `github-app rotate-secret`) can join the same family.
 */
const githubAppCreateCommand = Command.make(
  "create",
  {
    endpoint: Options.text("endpoint"),
    // `--open` / `--no-open`. Absent → defer to the interactive-terminal
    // heuristic in `runGithubAppCreateFromOption` (only pop a browser for a
    // human at a TTY); present → force the choice.
    open: Options.boolean("open", { negationNames: ["no-open"] }).pipe(
      Options.withDescription(
        "Auto-open the install URL in a browser. Defaults on at an interactive terminal, off when piped/non-interactive or under CI. Use --no-open to suppress.",
      ),
      Options.optional,
    ),
  },
  ({ endpoint, open }) =>
    runGithubAppCreateFromOption(endpoint, { open }).pipe(
      Effect.catchAll(reportGithubAppFailure),
    ),
);

export const githubAppCommand = Command.make("github-app", {}).pipe(
  Command.withSubcommands([githubAppCreateCommand]),
);
