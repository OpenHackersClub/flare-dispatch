// Root vitest workspace — picks up every package's own vitest config so
// `pnpm test` at the repo root runs the whole monorepo's suites.
//
// PR1 left `pnpm test` as `vitest run --passWithNoTests`; PR2 adds the first
// real suite (@flare-dispatch/core); PR3 adds the run-level suite under
// `runs/`. This workspace file is the seam each new package's tests slot into
// without touching the root script.

export default ["packages/*", "runs"];
