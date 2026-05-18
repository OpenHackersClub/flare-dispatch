/**
 * Catalog of recipes — worked examples of wiring real CI use cases onto
 * FlareDispatch. Source files live in the monorepo-root `recipes/` directory;
 * the recipe pages read them from disk at build time.
 */

export type RecipeFile = {
  /** File name relative to `recipes/<slug>/`. */
  name: string;
  /** Shiki language id for syntax highlighting. */
  lang: "yaml" | "ts";
};

export type Recipe = {
  slug: string;
  label: string;
  useCase: string;
  mode: "Action" | "Webhook";
  blurb: string;
  /** Source files shown as code on the recipe page. */
  files: RecipeFile[];
  /** Whether `recipes/<slug>/README.md` exists and should render as prose. */
  hasReadme: boolean;
};

export const recipes: Recipe[] = [
  {
    slug: "browser-tests",
    label: "Browser tests",
    useCase: "Playwright e2e suite, sharded across the browser pool",
    mode: "Action",
    blurb:
      "Offload a Playwright e2e suite to the shipped `playwright-e2e` run — sharded across the Browser Rendering pool, results posted back as a Check Run.",
    files: [{ name: "ci.yml", lang: "yaml" }],
    hasReadme: false,
  },
  {
    slug: "test-matrix",
    label: "Test matrix",
    useCase: "Same command fanned out across N shards",
    mode: "Action",
    blurb:
      "Fan one test command across N shards via the `matrix-fanout` run — Workflows `createBatch` spawns the children, scale-to-zero between runs.",
    files: [{ name: "ci.yml", lang: "yaml" }],
    hasReadme: false,
  },
  {
    slug: "cdp-acceptance",
    label: "CDP acceptance",
    useCase: "Boot an app, drive it over CDP, assert on observations",
    mode: "Action",
    blurb:
      "Boot an app, drive it over the Chrome DevTools Protocol, and assert on network / console / heap observations using the `cdp-acceptance` run.",
    files: [{ name: "ci.yml", lang: "yaml" }],
    hasReadme: false,
  },
  {
    slug: "security-scan",
    label: "Security scan",
    useCase: "Dependency / vulnerability scan, on PR and weekly",
    mode: "Action",
    blurb:
      "Run a dependency and vulnerability scan with the `security-scan` run — gated on PRs and on a weekly schedule, no GHA minutes burned on the scan itself.",
    files: [{ name: "ci.yml", lang: "yaml" }],
    hasReadme: false,
  },
  {
    slug: "deploy-smoke",
    label: "Deploy smoke",
    useCase: "Hit critical URLs after a successful deploy",
    mode: "Webhook",
    blurb:
      "A custom DSL run that hits critical URLs after a successful deploy. The GitHub App webhook fires it directly — zero GHA minutes, no workflow file.",
    files: [{ name: "smoke.run.ts", lang: "ts" }],
    hasReadme: false,
  },
  {
    slug: "ai-code-review",
    label: "AI code review",
    useCase: "Multi-agent AI review on every PR",
    mode: "Webhook",
    blurb:
      "A FlareDispatch port of Cloudflare's multi-agent code reviewer — up to seven domain-specific agents review every PR, findings deduplicated into one consolidated review.",
    files: [{ name: "pr-review.run.ts", lang: "ts" }],
    hasReadme: true,
  },
];
