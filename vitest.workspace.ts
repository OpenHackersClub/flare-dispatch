// Root vitest workspace — picks up every package's own vitest config so
// `pnpm test` at the repo root runs the whole monorepo's suites.
//
// PR1 left `pnpm test` as `vitest run --passWithNoTests`; PR2 adds the first
// real suite (@flare-dispatch/core); PR3 adds the run-level suite under
// `runs/`; PR4 adds the Miniflare-backed integration suite in
// `packages/runtime-cf` (picked up by the `packages/*` glob); PR5 adds the
// Dispatcher route suite under `apps/dispatcher`. This workspace file is the
// seam each new package's tests slot into without touching the root script.

// The `packages/*` glob resolves each package's default `vitest.config.ts`
// (Node project). `packages/runtime-cf/vitest.workers.config.ts` is registered
// explicitly as a SECOND runtime-cf project: its `*.workers.test.ts` suites run
// inside workerd via `@cloudflare/vitest-pool-workers` (unblocked by the Vitest
// 3 upgrade). Projects don't nest, so it can't live under the package's own
// config — it's a sibling entry here.
export default [
  "packages/*",
  "packages/runtime-cf/vitest.workers.config.ts",
  "runs",
  "apps/dispatcher",
];
