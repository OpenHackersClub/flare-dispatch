// Generate the recipe mirrors from their deployed runs.
//
// `spec-drift-pr` and `ci-triage-pr` ship BOTH as deployed runs (`runs/*.ts`)
// and as copy-paste recipe templates (`recipes/<name>/<name>.run.ts`). The two
// were byte-identical save a header banner — so they're generated here instead
// of hand-maintained, and CI runs this with `--check` to fail on drift.
//
// Write mode (default): regenerate each recipe from its run.
// Check mode (`--check`): exit 1 if any recipe is stale (prints which).
//
// Plain ESM so it runs under bare `node` — no tsx / build step.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Each deployed run and the recipe file it generates. */
const PAIRS = [
  {
    run: "runs/spec-drift-pr.ts",
    recipe: "recipes/spec-drift-pr/spec-drift-pr.run.ts",
  },
  {
    run: "runs/ci-triage-pr.ts",
    recipe: "recipes/ci-triage-pr/ci-triage-pr.run.ts",
  },
];

/** The recipe banner that replaces the run's `// Run: <title>` first line. */
const banner = (title, runBase) => [
  `// Recipe: ${title}`,
  "//",
  `// Identical to the deployed \`runs/${runBase}.ts\`. Drop into your repo's`,
  "// `runs/` directory; the Dispatcher auto-discovers it. See ./README.md.",
];

/** Render the recipe content for a run file: swap the banner, keep the body. */
const render = (runPath) => {
  const src = readFileSync(runPath, "utf8");
  const lines = src.split("\n");
  if (!lines[0].startsWith("// Run: ")) {
    throw new Error(
      `${runPath}: expected the first line to start with "// Run: " (got ${JSON.stringify(lines[0])})`,
    );
  }
  const title = lines[0].slice("// Run: ".length);
  const runBase = runPath.split("/").pop().replace(/\.ts$/, "");
  return [...banner(title, runBase), ...lines.slice(1)].join("\n");
};

const check = process.argv.includes("--check");
const root = process.cwd();
let drift = false;

for (const { run, recipe } of PAIRS) {
  const expected = render(resolve(root, run));
  const recipePath = resolve(root, recipe);
  if (check) {
    const actual = readFileSync(recipePath, "utf8");
    if (actual !== expected) {
      drift = true;
      console.error(
        `[sync-recipes] STALE: ${recipe} is out of sync with ${run} — run \`pnpm sync-recipes\``,
      );
    }
  } else {
    writeFileSync(recipePath, expected);
    console.log(`[sync-recipes] wrote ${recipe} from ${run}`);
  }
}

if (check && drift) process.exit(1);
if (check) console.log("[sync-recipes] all recipe mirrors in sync");
