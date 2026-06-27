// Emit the MODELED per-recipe benchmark dataset for the docs site.
//
// `apps/docs/src/data/benchmarks.json` is the deterministic, build-time
// speed+cost projection the docs `/benchmarks` page renders. It is MODELED, not
// metered: each recipe's cost is a curated workload profile (instance type,
// typical wall-time, model-call shape) priced through the rate card below. The
// app dashboard's `/v1/analytics.json` carries the MEASURED twin from real D1
// executions.
//
// Source of truth for the rate card: packages/core/src/cost.ts. This script is
// intentionally plain ESM so it runs under bare `node` in CI (alongside
// sync-recipes.mjs / emit-signals-schema.mjs, which can't import the TS module).
// The rate constants below are hand-mirrored; `packages/core/src/cost.test.ts`
// reads the committed JSON's `rateCard` and fails CI if it diverges from the
// exported TS constants, so the two can't silently drift.
//
// Write mode (default): (re)write apps/docs/src/data/benchmarks.json.
// Check mode (`--check`): exit 1 if the committed file is stale (CI gate).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const OUT_PATH = "apps/docs/src/data/benchmarks.json";

// --- Rate card (MIRRORED from packages/core/src/cost.ts; guarded by cost.test.ts) ---

const CONTAINER_VCPU_MICRO_USD_PER_SEC = 20; // $0.000020/vCPU-s
const CONTAINER_GIB_MICRO_USD_PER_SEC = 2.5; // $0.0000025/GiB-s

/** vCPU / GiB by instance type (specs/05-byoc.md § Wrangler config). */
const INSTANCE_SPECS = {
  lite: { vcpu: 1 / 16, gib: 0.25 },
  basic: { vcpu: 1 / 4, gib: 1 },
  "standard-1": { vcpu: 1 / 2, gib: 4 },
  "standard-2": { vcpu: 1, gib: 6 },
  "standard-3": { vcpu: 2, gib: 8 },
  "standard-4": { vcpu: 4, gib: 12 },
};

/** USD per 1M input/output tokens by model family (Claude rate card; DeepSeek approx). */
const MODEL_RATES = {
  opus: { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  sonnet: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  haiku: { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  deepseek: { inputPerMTokUsd: 0.55, outputPerMTokUsd: 2.19 },
};

/** Resolve a model id to its family rate, or null when unmetered (Workers AI catalog). */
const modelRate = (model) => {
  const id = model.toLowerCase();
  if (id.startsWith("@cf/")) return null;
  if (id.includes("opus-4")) return MODEL_RATES.opus;
  if (id.includes("sonnet-4")) return MODEL_RATES.sonnet;
  if (id.includes("haiku-4")) return MODEL_RATES.haiku;
  if (id.includes("deepseek")) return MODEL_RATES.deepseek;
  return null;
};

const containerMicroUsd = (instance, activeSeconds) => {
  const spec = INSTANCE_SPECS[instance];
  return Math.round(
    spec.vcpu * activeSeconds * CONTAINER_VCPU_MICRO_USD_PER_SEC +
      spec.gib * activeSeconds * CONTAINER_GIB_MICRO_USD_PER_SEC,
  );
};

const modelMicroUsd = (model, inputTokens, outputTokens) => {
  const rate = modelRate(model);
  if (rate === null) return null;
  return Math.round(inputTokens * rate.inputPerMTokUsd + outputTokens * rate.outputPerMTokUsd);
};

// --- Workload profiles — one per registered run (runs/index.ts) ----------------
//
// MODELED planning estimates. `instance` is the run's Durable Object class
// (lean/browser → standard-2, agent → standard-3). `wallSeconds` is a typical
// end-to-end time (the speed column); `containerSeconds` is the modeled
// container-active window (== wall for test-running runs; far smaller for the
// model-calling runs, whose container only clones + diffs). The model-calling
// runs are priced against the Anthropic backend as a representative METERED
// figure — the default Workers AI catalog backend is account-billed (see note).

const REP_MODEL = "anthropic/claude-sonnet-4-6";

const PROFILES = [
  {
    name: "pr-review",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 45,
    containerSeconds: 6,
    model: { id: REP_MODEL, inputTokens: 105_000, outputTokens: 7_000 },
    note: "Multi-agent fan-out (≤7 reviewers each embed the diff). Model cost shown for the Anthropic backend; the default Workers AI catalog backend is account-billed (unmetered).",
  },
  {
    name: "offload-test",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Clone → install → `pnpm test` → log. Container compute is ~95% of marginal cost.",
  },
  {
    name: "matrix-fanout",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Per shard — N shards run concurrently across containers (×N container cost).",
  },
  {
    name: "vitest-shard",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 300,
    containerSeconds: 300,
    model: null,
    note: "One container per `--shard=i/n` slice.",
  },
  {
    name: "oxlint",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 25,
    containerSeconds: 25,
    model: null,
    note: "Install-free Rust lint gate — the cheapest run (no node_modules), via short wall-time.",
  },
  {
    name: "cdp-acceptance",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Boot app + CDP assertions. Browser Rendering hours add on top (within the included 10 hr/mo at low volume).",
  },
  {
    name: "playwright-e2e",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Playwright specs → signed R2 tarball. Browser Rendering hours add on top.",
  },
  {
    name: "playwright-demo",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Smaller Playwright walkthrough.",
  },
  {
    name: "product-demo",
    kind: "wall-clock",
    instance: "standard-3",
    wallSeconds: 180,
    containerSeconds: 180,
    model: { id: "@cf/demo-agent", inputTokens: 0, outputTokens: 0 },
    note: "AI-driven CDP walkthrough on the agent image (standard-3, chromium + demo-agent). The demo-agent's model cost is account-billed Workers AI (unmetered).",
  },
  {
    name: "deploy-smoke",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 60,
    containerSeconds: 60,
    model: null,
    note: "Post-deploy health probe.",
  },
  {
    name: "email-otp-login",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 90,
    containerSeconds: 90,
    model: null,
    note: "Drives an OTP / magic-link login via a disposable inbox.",
  },
  {
    name: "refresh-fixtures",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Regenerates fixtures → proposes a writeback PR.",
  },
  {
    name: "ci-triage-pr",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 40,
    containerSeconds: 5,
    model: { id: REP_MODEL, inputTokens: 12_000, outputTokens: 1_500 },
    note: "Reads failed Pages deployments + asks a model to triage. Model cost shown for the Anthropic backend.",
  },
  {
    name: "spec-drift-pr",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 90,
    containerSeconds: 30,
    model: { id: REP_MODEL, inputTokens: 40_000, outputTokens: 4_000 },
    note: "Reconciles specs ↔ code → draft PR. Model cost shown for the Anthropic backend.",
  },
  {
    name: "release-notes",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 30,
    containerSeconds: 5,
    model: { id: REP_MODEL, inputTokens: 8_000, outputTokens: 2_000 },
    note: "Summarizes merged PRs since the last tag. Model cost shown for the Anthropic backend.",
  },
  {
    name: "finops-audit",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 30,
    containerSeconds: 2,
    model: { id: REP_MODEL, inputTokens: 3_000, outputTokens: 1_500 },
    note: "Weekly cost review (reads account usage, no real container). Model cost shown for the Anthropic backend.",
  },
];

const recipes = PROFILES.map((p) => {
  const container = containerMicroUsd(p.instance, p.containerSeconds);
  const model =
    p.model !== null
      ? modelMicroUsd(p.model.id, p.model.inputTokens, p.model.outputTokens)
      : null;
  const total = container + (model ?? 0);
  return {
    name: p.name,
    kind: p.kind,
    instance: p.instance,
    wallSeconds: p.wallSeconds,
    containerSeconds: p.containerSeconds,
    modelId: p.model?.id ?? null,
    inputTokens: p.model?.inputTokens ?? null,
    outputTokens: p.model?.outputTokens ?? null,
    containerMicroUsd: container,
    modelMicroUsd: model,
    // True when the model call is priced (metered rate exists), false when the
    // backend is Workers AI catalog (account-billed Neurons, no per-call tokens).
    modelMetered: p.model !== null && model !== null,
    totalMicroUsd: total,
    note: p.note,
  };
});

const dataset = {
  // The docs page renders this verbatim; cost.test.ts checks `rateCard`.
  source: "Generated by scripts/emit-benchmarks.mjs from the rate card mirrored from packages/core/src/cost.ts.",
  basis: "modeled",
  rateCard: {
    vcpuMicroUsdPerSec: CONTAINER_VCPU_MICRO_USD_PER_SEC,
    gibMicroUsdPerSec: CONTAINER_GIB_MICRO_USD_PER_SEC,
    instances: INSTANCE_SPECS,
    models: MODEL_RATES,
  },
  recipes,
};

const json = `${JSON.stringify(dataset, null, 2)}\n`;
const absPath = resolve(process.cwd(), OUT_PATH);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(absPath, "utf8");
  } catch {
    console.error(`✗ ${OUT_PATH} is missing — run \`node scripts/emit-benchmarks.mjs\``);
    process.exit(1);
  }
  if (current !== json) {
    console.error(`✗ ${OUT_PATH} is stale — run \`node scripts/emit-benchmarks.mjs\``);
    process.exit(1);
  }
  console.log(`✓ ${OUT_PATH} is up to date`);
} else {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, json);
  console.log(`✓ wrote ${OUT_PATH} (${recipes.length} recipes)`);
}
