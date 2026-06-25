import { defineConfig } from "tsdown";

// demo-agent — bundle the AI-driven demo CLI into a single self-contained CJS
// binary baked into the demo container image (Dockerfile.sandbox COPYs
// dist/demo-agent.cjs onto PATH and smoke-tests `demo-agent --help`).
//
// tsdown (Rolldown + Oxc) replaces the hand-rolled esbuild invocation. The
// binary runs in a container with NO `node_modules`, so every dependency
// (effect, @effect/*, puppeteer-core, pngjs, gifenc, the workspace
// bedrock-sigv4) must be inlined — `deps.alwaysBundle` overrides tsdown's
// library default of externalizing dependencies. The entry is a pure
// side-effect CLI (no exports), so `treeshake: false` keeps its top-level run
// from being dropped; the source carries its own `#!/usr/bin/env node`.
export default defineConfig({
  entry: { "demo-agent": "src/bundle-entry.ts" },
  format: "cjs",
  platform: "node",
  target: "node20",
  outDir: "dist",
  deps: { alwaysBundle: [/./] },
  treeshake: false,
  dts: false,
  // ONE self-contained file — the Dockerfile COPYs only `demo-agent.cjs` onto
  // PATH, so puppeteer-core's dynamic imports (bidi, etc.) must be inlined
  // rather than emitted as sibling chunks the container wouldn't have.
  codeSplitting: false,
});
