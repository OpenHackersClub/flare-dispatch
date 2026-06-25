#!/usr/bin/env node
// @flare-dispatch/demo-agent — bundle entry point.
//
// `src/main.ts` is the local-dev `bin` target carrying a `tsx` shebang so
// `pnpm demo-agent <cmd>` runs through `tsx` without an explicit build step.
// This file is the entry for the production bundle (`pnpm build` →
// `dist/demo-agent.cjs`). The `#!/usr/bin/env node` shebang above IS the entry
// hashbang tsdown preserves at the top of the emitted CJS — and the trigger for
// tsdown granting the bundle execute permission. The Dockerfile COPYs the
// bundle onto PATH and runs `demo-agent --help` directly, so without a shebang
// the kernel falls back to /bin/sh, which chokes on the JS ("Syntax error: word
// unexpected") and fails the image build. (The old esbuild build injected this
// via `--banner:js=…node…`; tsdown takes it from the entry source instead,
// matching flare-agent's `src/main.ts`.)

// Side-effect import — main.ts's top level runs the CLI when the bundle is
// loaded. `import "./main.js"` (not `export *`) guarantees evaluation under
// any module system tsdown picks.
import "./main.js";
