/**
 * Catalog of recipes — worked examples of wiring real CI use cases onto
 * FlareDispatch. Source files live in the monorepo-root `recipes/` directory;
 * the recipe pages read them from disk at build time.
 *
 * Order is intentional: agentic code review leads — it is the highest-value
 * job to move off GitHub Actions — ahead of Playwright e2e and the rest.
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
  mode: "Action" | "Webhook" | "Schedule";
  blurb: string;
  /** Source files shown as code on the recipe page (the FlareDispatch shape). */
  files: RecipeFile[];
  /**
   * The baseline GHA workflow shown under the "Without FlareDispatch" tab —
   * a faithful, runnable workflow a team would actually maintain to do the
   * same job on plain GitHub Actions. Lives at `recipes/<slug>/baseline.yml`.
   *
   * Optional: a recipe without a `baseline` skips the comparison widget
   * entirely (the page renders the typed run as the single Source section).
   * Most Action- and Webhook-mode recipes ship a baseline; the Schedule-mode
   * recipes intentionally do not — a wall-clock cron has no GHA-native event
   * to compare against, so there is no faithful baseline workflow to show.
   */
  baseline?: RecipeFile;
  /**
   * Bullet list of the structural costs a team pays to implement this recipe
   * on plain GHA. Only meaningful when `baseline` is set.
   */
  baselinePains?: string[];
  /**
   * Structural-shape label for the comparison meta panel. Only rendered when
   * `baseline` is set. Honest LOC comparisons are misleading when one side
   * carries dense doc comments, so this is a qualitative label.
   */
  shape?: {
    /** "1 typed run + dispatch", "2 typed runs", … */
    flare: string;
    /** "1 workflow · 4 jobs + matrix", "1 workflow · cron + REST", … */
    gha: string;
  };
  /** Whether `recipes/<slug>/README.md` exists and should render as prose. */
  hasReadme: boolean;
};

export const recipes: Recipe[] = [
  {
    slug: "ai-code-review",
    label: "AI code review",
    useCase: "Configurable single- or multi-agent code review on every PR — plus a nightly sweep",
    mode: "Webhook",
    blurb:
      "A FlareDispatch port of Cloudflare's multi-agent code reviewer — up to seven domain-specific agents review every PR (`pr-review.agents=multi`), findings deduplicated into one consolidated review; or one generalist reviewer (`agents=single`) for a leaner pass. Backend is selectable from CONFIG_KV without redeploy (Workers AI, Anthropic-via-AI-Gateway BYOK, or Bedrock via the OIDC→STS→SigV4 BYOC trust path), and a dispatch can override the model/region/role per call for model bake-offs. Fires on every push (Webhook mode) for zero GHA minutes; an optional Schedule-mode sweep re-reviews every open PR on a cron cadence.",
    files: [
      { name: "pr-review.run.ts", lang: "ts" },
      { name: "pr-review-sweep.run.ts", lang: "ts" },
      { name: "ci.yml", lang: "yaml" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "Three jobs chained with `needs:` (gate → prepare-diff → matrix → coordinate) because GHA has no in-job fan-out that can both read shared state AND produce per-shard artifacts.",
      "The agent matrix is JSON-encoded into a job output and parsed by `fromJSON()` — GHA's `matrix:` block cannot read step outputs directly.",
      "The diff round-trips through `actions/upload-artifact` so every shard can see it (GHA does not share the workspace across jobs).",
      "Inline annotations are batched 50-per-call by hand against the GitHub REST API — there is no first-class \"check-run from JSON\" action.",
      "Re-review continuity (prior findings) leans on `actions/cache@v4`, which can evict at any moment; FlareDispatch's `io.priorExecution` is durable.",
      "A second cron workflow + `actions/github-script` PR-enumeration loop is required to cover webhook drops and PRs opened before the workflow existed.",
    ],
    shape: {
      flare: "2 typed runs + dispatch",
      gha: "1 workflow · 5 jobs + matrix + REST glue",
    },
    hasReadme: true,
  },
  {
    slug: "browser-tests",
    label: "Browser tests",
    useCase: "Playwright e2e suite, sharded across the browser pool",
    mode: "Action",
    blurb:
      "Offload a Playwright e2e suite to the shipped `playwright-e2e` run — sharded across the Browser Rendering pool, results posted back as a Check Run.",
    files: [
      { name: "ci.yml", lang: "yaml" },
      { name: "playwright-e2e.run.ts", lang: "ts" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "Every shard pays the GHA-runner cold-start tax (~30–45 s) — for an N=4 run, ~2–3 minutes of GHA minutes burned before tests start.",
      "Chromium is installed on every shard via `playwright install --with-deps` (~60–90 s each); FlareDispatch's `flare-dispatch-playwright` image has it baked in and the container pool is warm.",
      "Per-shard reports upload to blob storage and a separate `merge-reports` job downloads them all and re-glues — branch protection must require the merge job, not the matrix.",
      "`fail-fast: false` is required for independent shards, but then the matrix job is green even on partial failure — you add a manual aggregate gate.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · matrix + merge-reports job",
    },
    hasReadme: false,
  },
  {
    slug: "test-matrix",
    label: "Test matrix",
    useCase: "Same command fanned out across N shards",
    mode: "Action",
    blurb:
      "Fan one test command across N shards via the `matrix-fanout` run — Workflows `createBatch` spawns the children, scale-to-zero between runs.",
    files: [
      { name: "ci.yml", lang: "yaml" },
      { name: "matrix-fanout.run.ts", lang: "ts" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "Shard count is hardcoded twice (the `matrix:` list AND the `--shard $i/$N` divisor) — bump 4 to 8 and you must remember both.",
      "Every shard pays runner cold-start + `pnpm install` cost; the warm worker pool in FlareDispatch boots in <2 s.",
      "`fail-fast: false` is required to let independent shards run, but then a separate aggregate job has to propagate failure to the PR check.",
      "Per-shard logs only viewable via the Artifacts UI; FlareDispatch surfaces them as signed R2 URLs in the check-run summary.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · matrix + aggregate job",
    },
    hasReadme: false,
  },
  {
    slug: "cdp-acceptance",
    label: "CDP acceptance",
    useCase: "Boot an app, drive it over CDP, assert on observations",
    mode: "Action",
    blurb:
      "Boot an app, drive it over the Chrome DevTools Protocol, and assert on network / console / heap observations using the `cdp-acceptance` run.",
    files: [
      { name: "ci.yml", lang: "yaml" },
      { name: "cdp-acceptance.run.ts", lang: "ts" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "App boot is `nohup … &` plus a hand-rolled retry loop on the dev port; FlareDispatch's `bootApp` primitive subsumes both.",
      "Chromium is launched on the runner with `--remote-debugging-port` because GHA can't reach Cloudflare Browser Rendering — only one acceptance suite per machine.",
      "Screenshots and the Playwright trace live behind the Artifacts UI; the reviewer must download → unzip → re-upload to paste evidence into the PR. FlareDispatch hands them a signed R2 URL.",
      "Background-process lifecycle (kill the app + the headless browser) is your responsibility — `if: always()` cleanup steps that have to be remembered.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · 1 job · 10+ steps with detach/wait/cleanup",
    },
    hasReadme: false,
  },
  {
    slug: "product-demo",
    label: "Product demo",
    useCase:
      "AI-driven walkthrough video of a deployed site, with a per-story summary",
    mode: "Action",
    blurb:
      "Hand a deployed URL and a list of user stories in prose; the `product-demo` run attaches Browser Run over CDP with native rrweb session recording enabled, drives the site through each story sequentially over ONE recorded session, captures key screenshots, and writes a holistic markdown summary a reviewer pastes into the PR. The returned `replayUri` opens the rrweb player so reviewers can scrub the walkthrough inline. Fires per-PR via `ci.yml` (Action mode), and ALSO carries an optional `schedules: [{ cron, inputs }]` block for a daily stakeholder-facing run against staging — same run code, both trigger paths.",
    files: [
      { name: "ci.yml", lang: "yaml" },
      { name: "product-demo.run.ts", lang: "ts" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "Playwright's `recordVideo` is per-`BrowserContext` — one story = one .webm, and there is no clean way to stitch them into one master video with chapter markers.",
      "Every PR pays runner cold-start + `playwright install --with-deps chromium` (~60–90 s on a cold cache) before the first frame is recorded; FlareDispatch's `flare-dispatch-demo` image is warm and pre-baked.",
      "`ANTHROPIC_API_KEY` is a GHA secret exposed to every step, postinstall, and third-party action in the job; the FlareDispatch agent lives inside the container image so the key never touches the runner.",
      "Stories run sequentially against a shared browser, so the LLM round-trip per story burns GHA runner minutes while the model thinks — FlareDispatch containers scale to zero between deploys.",
      "GitHub PR comments cannot embed video — the GHA `actions/upload-artifact` flow yields a download link the reviewer has to unzip and watch locally; FlareDispatch hands them a 30-day signed R2 URL they drop straight into the PR description.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · 1 job · Playwright + Anthropic SDK + per-context .webms",
    },
    hasReadme: true,
  },
  {
    slug: "security-scan",
    label: "Security scan",
    useCase: "Dependency / vulnerability scan, on PR and weekly",
    mode: "Action",
    blurb:
      "Run a dependency and vulnerability scan with the `security-scan` run — gated on PRs and on a weekly schedule, no GHA minutes burned on the scan itself.",
    files: [
      { name: "ci.yml", lang: "yaml" },
      { name: "security-scan.run.ts", lang: "ts" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "Each scanner is its own job because install/setup differs — Trivy needs apt repos, gitleaks needs a tarball, pnpm-audit needs `pnpm` already set up.",
      "Every scanner has its own \"fail on high\" flag dialect (`--exit-code 1`, `--audit-level=high`, grep-the-output) — no shared FAIL_ON threshold like FlareDispatch's `scan` CLI wrapper.",
      "The aggregate gate is a fourth job that has to download every report and call `contains(needs.*.result, 'failure')` — branch protection requires the aggregate, not the scanners.",
      "Scheduled (weekly) and PR runs share one workflow, so any comment-back logic branches on `github.event_name`.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · 4 jobs (per-scanner + aggregate)",
    },
    hasReadme: false,
  },
  {
    slug: "deploy-smoke",
    label: "Deploy smoke",
    useCase: "Hit critical URLs after a successful deploy",
    mode: "Webhook",
    blurb:
      "A custom DSL run that hits critical URLs after a successful deploy. The GitHub App webhook fires it directly — zero GHA minutes, no workflow file; an Action-mode `ci.yml` is included as the GHA-native alternative.",
    files: [
      { name: "smoke.run.ts", lang: "ts" },
      { name: "ci.yml", lang: "yaml" },
    ],
    baseline: { name: "baseline.yml", lang: "yaml" },
    baselinePains: [
      "`on: deployment_status` fires on every transition (pending, in_progress, success, failure) — you gate manually on three independent conditions or the smoke fires multiple times per deploy.",
      "The check-run on the deployed SHA must be manually created via REST (the GHA job's status anchors to the workflow SHA, not the deployment SHA).",
      "No idempotency on `deployment.id` — a re-delivered webhook re-fires the smoke. FlareDispatch's `idempotencyKey` deduplicates in the kernel.",
      "The probe loop is curl + exit-code classification in shell; FlareDispatch's `probeHttp` primitive subsumes it with tagged-error classification and parallel probes.",
    ],
    shape: {
      flare: "1 typed run + dispatch",
      gha: "1 workflow · 1 job + REST check-run lifecycle",
    },
    hasReadme: false,
  },
  {
    slug: "nightly-e2e",
    label: "Nightly e2e",
    useCase: "Nightly Playwright suite across your deployed environments",
    mode: "Schedule",
    blurb:
      "The simplest Schedule-mode shape: a Cloudflare Cron Trigger fires the run every night, and it dispatches the shipped playwright-e2e run against a fixed list of environments. Static targets — no enumeration, no GHA minutes, no workflow file.",
    files: [{ name: "nightly-e2e.run.ts", lang: "ts" }],
    hasReadme: true,
  },
  {
    slug: "release-notes",
    label: "Release notes",
    useCase: "Weekly release notes, drafted then published behind a human gate",
    mode: "Schedule",
    blurb:
      "A weekly Cron Trigger drafts release notes from git history, posts the draft, and hibernates on step.waitForEvent — up to 72h at zero CPU cost — until a human approves, then publishes the GitHub Release.",
    files: [{ name: "release-notes.run.ts", lang: "ts" }],
    hasReadme: true,
  },
  {
    slug: "scheduled-deps",
    label: "Scheduled deps audit",
    useCase: "Nightly dependency audit across every installed repo",
    mode: "Schedule",
    blurb:
      "A nightly Cron Trigger enumerates every repo the App is installed on via the github capability and fans out the shipped security-scan run per repo — so a freshly disclosed CVE surfaces within a day, not at the next unrelated push.",
    files: [{ name: "scheduled-deps.run.ts", lang: "ts" }],
    hasReadme: true,
  },
  {
    slug: "spec-drift-pr",
    label: "Spec drift → draft PR",
    useCase:
      "Daily spec/implementation drift detection — files the reconciling spec edits as a draft PR",
    mode: "Schedule",
    blurb:
      "A daily Cron Trigger scans each configured repo for drift between specs/ and the implementation, asks the same configurable opencode/reasonix backend ai-code-review uses (under its own spec-drift.* CONFIG_KV namespace), and commits the proposed spec edits via the GitHub Git Data API — straight from the Worker, no container git push — as a draft PR a human reviews.",
    files: [{ name: "spec-drift-pr.run.ts", lang: "ts" }],
    hasReadme: true,
  },
  {
    slug: "ci-triage-pr",
    label: "CI triage → draft PR",
    useCase:
      "Daily triage of GitHub Actions + Cloudflare deploy failures — files the write-up as a draft PR",
    mode: "Schedule",
    blurb:
      "A daily Cron Trigger reads recent failures from github.actionRuns and the read-only cloudflare capability (Pages deployments), clusters them with a model-written diagnosis + suggested next steps (ci-triage.* namespace, operator-overridable prompt), and opens one draft PR carrying the triage report. A green day opens nothing and never calls the model.",
    files: [{ name: "ci-triage-pr.run.ts", lang: "ts" }],
    hasReadme: true,
  },
];
