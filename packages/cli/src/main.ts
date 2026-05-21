#!/usr/bin/env tsx
// FlareDispatch operator CLI entry point.
//
// `@effect/cli` builds the command tree; `@effect/platform-node` provides the
// FileSystem / Path / Terminal services its `Command.run` resolves. Subcommands
// live in `./commands/*` — each is a typed `Command` value composed in via
// `Command.withSubcommands`.
//
// Spec: specs/05-byoc.md § CLI.

import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { githubApp } from "./commands/github-app";

const root = Command.make("flare-dispatch").pipe(
  Command.withSubcommands([githubApp]),
);

const cli = Command.run(root, {
  name: "flare-dispatch",
  version: "0.0.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
