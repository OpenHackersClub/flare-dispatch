// @flare-dispatch/demo-agent — bundle entry point.
//
// `src/main.ts` is the local-dev `bin` target carrying a `tsx` shebang so
// `pnpm demo-agent <cmd>` runs through `tsx` without an explicit build step.
// This file is the entry for the production bundle (`pnpm build` →
// `dist/demo-agent.cjs`) — no shebang here so esbuild's `--banner:js=…node…`
// is the only shebang on the resulting binary. The container image's
// COPY-to-/usr/local/bin/demo-agent step is what makes the bundle executable.

// Side-effect import — main.ts's top level runs the CLI when the bundle is
// loaded. `import "./main.js"` (not `export *`) guarantees evaluation under
// any module system esbuild picks.
import "./main.js";
