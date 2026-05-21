#!/usr/bin/env -S npx tsx
// FlareDispatch CLI — entry point.
//
// Wires the typed subcommands (`dispatch` today; more later) into a single
// top-level `@effect/cli` app. Run with `pnpm --filter @flare-dispatch/cli
// cli <subcommand>` (the package.json `cli` script invokes `tsx src/main.ts`).
//
// The CLI is the migration target for `actions/flare-dispatch-action/
// dispatch.sh` per CLAUDE.md § CI & Test Tooling — Prefer Effect-TS CLI Over
// Inline Shell. The Action itself runs the bundled `action-entry.ts` directly
// (no argv parser); this binary is the human-facing equivalent.

import * as Command from "@effect/cli/Command";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { dispatchCommand } from "./command.js";

const root = Command.make("flare-dispatch").pipe(
  Command.withSubcommands([dispatchCommand]),
);

const cli = Command.run(root, {
  name: "FlareDispatch CLI",
  version: "0.0.0",
});

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
