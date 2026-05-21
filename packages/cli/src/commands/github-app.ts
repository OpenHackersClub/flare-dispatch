// `flare-dispatch github-app create` — print the URL an operator opens in
// their browser to mint the FlareDispatch GitHub App on a chosen account.
//
// The actual manifest-exchange flow runs on the Dispatcher Worker
// (apps/dispatcher/src/routes/github-start.ts +
// apps/dispatcher/src/routes/github-installed.ts) — this command is sugar
// over composing one URL. See specs/05-byoc.md § GitHub App setup for the
// end-to-end flow.

import { Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";

const endpoint = Options.text("endpoint").pipe(
  Options.withDescription(
    "Dispatcher base URL (e.g. https://flare-dispatch-v0.acme.workers.dev)",
  ),
);

const org = Options.text("org").pipe(
  Options.withDescription(
    "GitHub organization slug to install on. Omit for a personal-account install.",
  ),
  Options.optional,
);

/**
 * Pure URL builder for the start page. Exported so unit tests can lock the
 * shape without booting the full CLI runtime.
 */
export const buildStartUrl = (
  rawEndpoint: string,
  orgOpt: Option.Option<string>,
): string => {
  const base = rawEndpoint.replace(/\/+$/, "");
  const orgParam = Option.match(orgOpt, {
    onNone: () => "",
    onSome: (v) => `?org=${encodeURIComponent(v)}`,
  });
  return `${base}/v1/github/start${orgParam}`;
};

const create = Command.make(
  "create",
  { endpoint, org },
  ({ endpoint, org }) =>
    Effect.gen(function* () {
      const url = buildStartUrl(endpoint, org);
      yield* Console.log("");
      yield* Console.log(
        "Open this URL in your browser to create the FlareDispatch GitHub App:",
      );
      yield* Console.log("");
      yield* Console.log(`  ${url}`);
      yield* Console.log("");
      yield* Console.log(
        "The Dispatcher renders a one-click form that submits the App manifest",
      );
      yield* Console.log(
        "to GitHub. After GitHub creates the App, you'll be redirected back with",
      );
      yield* Console.log(
        "the App ID, webhook secret, and PEM, plus ready-to-paste `wrangler",
      );
      yield* Console.log("secret put` snippets.");
      yield* Console.log("");
    }),
);

export const githubApp = Command.make("github-app").pipe(
  Command.withSubcommands([create]),
);
