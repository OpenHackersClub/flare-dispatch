// FlareDispatch — JS Action entry.
//
// `actions/flare-dispatch-action/action.yml` declares `runs.using: node20`
// with `runs.main: dist/index.js` — that bundle is built from THIS file via
// `pnpm --filter @flare-dispatch/cli build`. The GitHub Actions runner
// invokes the bundle with NO arguments; every input arrives as an `INPUT_*`
// env var (set by the runner from `action.yml`'s `inputs:` block).
//
// We deliberately bypass both `@effect/cli` and `@effect/platform-node` here:
//
//   * `@effect/cli` is a parser — pointless with no argv.
//   * `@effect/platform-node`'s `NodeRuntime.runMain` is convenient but pulls
//     in `undici` (Node 20 has global `fetch`), which adds ~600 KB to the
//     bundle for nothing. `Effect.runPromiseExit` + `process.exit` is enough.
//
// `reportFailure` calls `Effect.die` on any tagged error, so the failure
// surfaces as a defect on the Exit — we map any non-Success Exit to exit
// code 1. The actual `::error::` annotation has already been printed.
//
// The standalone `flare-dispatch` CLI binary (`src/main.ts`) keeps the
// `@effect/cli` parser for human use — it's a separate entrypoint.

import { Effect, Exit } from "effect";
import { type DispatchEnv, reportFailure, runDispatch } from "./dispatch.js";

const program = runDispatch({ env: process.env as DispatchEnv }).pipe(
  Effect.asVoid,
  Effect.catchAll(reportFailure),
);

Effect.runPromiseExit(program).then((exit) => {
  process.exit(Exit.isSuccess(exit) ? 0 : 1);
});
