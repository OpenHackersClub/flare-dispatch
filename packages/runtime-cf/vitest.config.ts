import { defineConfig } from "vitest/config";

// runtime-cf integration tests drive real D1 / R2 via a Miniflare instance
// booted in test setup (see src/*.test.ts) — plain Node + Vitest, no Workers
// pool. Miniflare is started/stopped per suite, so the default forks pool is
// fine; the only requirement is a generous timeout for Miniflare cold-start.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
