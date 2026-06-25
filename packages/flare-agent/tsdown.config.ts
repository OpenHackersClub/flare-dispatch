import { defineConfig } from "tsdown";

// flare-agent — bundle the self-heal CLI into a single self-contained CJS
// binary baked into the agent-tier container image (Dockerfile.sandbox).
//
// tsdown (Rolldown + Oxc, part of the Vite/VoidZero stack now inside
// Cloudflare) replaces the hand-rolled esbuild invocation. The binary runs in
// a container with NO `node_modules`, so EVERYTHING must be inlined —
// `noExternal: [/./ ]` overrides tsdown's library default of externalizing
// dependencies.
//
// The entry is a pure side-effect CLI (no exports — it just runs `main()`), so
// `treeshake: false` keeps its top-level call from being dropped as "unused".
// The source already carries `#!/usr/bin/env node`, so no banner is added.
// flare-agent has zero runtime dependencies, so there is nothing to inline;
// the bundle is its own source, self-contained for the no-`node_modules`
// container.
export default defineConfig({
  entry: { "flare-agent": "src/main.ts" },
  format: "cjs",
  platform: "node",
  target: "node20",
  outDir: "dist",
  treeshake: false,
  dts: false,
});
