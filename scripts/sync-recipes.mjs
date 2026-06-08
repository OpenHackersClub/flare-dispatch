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

// `pr-review` ALSO ships as both a deployed run and a copy-paste recipe, but its
// run carries an elaborate shared header (CONFIG_KV docs, v3 rationale) rather
// than the one-line `// Run:` banner the `render` swap above expects — so it
// can't ride `PAIRS`. The recipe is the run VERBATIM save two recipe-only header
// edits: the design-doc pointer (`recipes/ai-code-review` → `./README.md`) and a
// "drop this into runs/" note. Encoding that as a transform OF THE RUN keeps the
// rest of the header (and the whole body) in sync automatically. Until this was
// added, the `--check` gate had a blind spot here and the v3.0.0→v3.1.0
// single/multi-agent collapse silently left the recipe stale.
const PR_REVIEW_HEADER_ANCHOR =
  "// https://blog.cloudflare.com/ai-code-review/ — see recipes/ai-code-review for\n// how the blog's design maps onto this run.";
const PR_REVIEW_RECIPE_HEADER =
  "// https://blog.cloudflare.com/ai-code-review/ — see ./README.md for how the\n// blog's design maps onto this run.\n//\n// Drop this file into your repo's `runs/`; it is identical to the deployed\n// `runs/pr-review.ts`. The review engine (`@flare-dispatch/review-agent`) runs\n// in the Worker — no `review-agent` CLI in the container image.";

/** Each deployed run whose recipe is a verbatim mirror + a header transform. */
const MIRRORS = [
  {
    run: "runs/pr-review.ts",
    recipe: "recipes/ai-code-review/pr-review.run.ts",
    transform: (src) => {
      if (!src.includes(PR_REVIEW_HEADER_ANCHOR)) {
        throw new Error(
          "runs/pr-review.ts: recipe header anchor not found — update PR_REVIEW_HEADER_ANCHOR in sync-recipes.mjs",
        );
      }
      return src.replace(PR_REVIEW_HEADER_ANCHOR, PR_REVIEW_RECIPE_HEADER);
    },
  },
];

const check = process.argv.includes("--check");
const root = process.cwd();
let drift = false;

const jobs = [
  ...PAIRS.map(({ run, recipe }) => ({
    run,
    recipe,
    expected: render(resolve(root, run)),
  })),
  ...MIRRORS.map(({ run, recipe, transform }) => ({
    run,
    recipe,
    expected: transform(readFileSync(resolve(root, run), "utf8")),
  })),
];

for (const { run, recipe, expected } of jobs) {
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
