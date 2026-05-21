// FlareDispatch CLI — `@effect/cli` subcommand definitions.
//
// Split out from `dispatch.ts` so that the JS-Action entry can import the
// dispatch flow without pulling `@effect/cli` into the bundle. The standalone
// `flare-dispatch` binary (`main.ts`) is the only consumer of this file.

import * as Command from "@effect/cli/Command";
import { Effect } from "effect";
import {
  type DispatchEnv,
  reportFailure,
  runDispatch,
} from "./dispatch.js";

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
