// Emit the GitHub App manifest template `infra/github-app-manifest.json`.
//
// The manifest is the BYOC source of truth: operators create their own
// FlareDispatch App from it (specs/05-byoc.md § GitHub App setup), and the
// Worker serves an origin-substituted copy at `/v1/github/install/new`. Because
// the Worker can't read files at runtime, that copy is an inlined TS literal
// (`MANIFEST_TEMPLATE` in apps/dispatcher/src/routes/github.ts); this committed
// JSON is the mirror the `github-app verify` CLI + docs read.
//
// Source of truth for THIS script: the literal below. It is intentionally plain
// ESM so it runs under bare `node` in CI (alongside emit-signals-schema.mjs),
// which can't import the TS literal. Two gates keep all three copies aligned:
//   * `--check` here  → committed JSON == this literal (native ci.yml gate)
//   * apps/dispatcher/src/routes/github-manifest-parity.test.ts
//                     → MANIFEST_TEMPLATE literal == committed JSON
//
// Write mode (default): (re)write the JSON. Check mode (`--check`): exit 1 if
// the committed file is stale (CI gate).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST_PATH = "infra/github-app-manifest.json";

/**
 * The App manifest. URLs are `runs.example.com` placeholders — the Worker
 * substitutes the request origin at install time, so they are NOT part of
 * registration drift detection (only default_permissions / default_events are).
 */
const manifest = {
  name: "FlareDispatch",
  description: "BYOC CI offload running on Cloudflare",
  url: "https://runs.example.com",
  hook_attributes: {
    url: "https://runs.example.com/v1/webhooks/github",
  },
  redirect_url: "https://runs.example.com/v1/github/installed",
  public: false,
  default_permissions: {
    checks: "write",
    contents: "read",
    deployments: "read",
    metadata: "read",
    // write — the check-run callback + pr-review comment both need it.
    pull_requests: "write",
  },
  default_events: ["check_run", "check_suite", "deployment_status", "pull_request"],
};

const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
const check = process.argv.includes("--check");
const path = resolve(process.cwd(), MANIFEST_PATH);

if (check) {
  let actual;
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    console.error(
      `[emit-app-manifest] ${MANIFEST_PATH} is missing — run 'node scripts/emit-app-manifest.mjs'`,
    );
    process.exit(1);
  }
  if (actual !== rendered) {
    console.error(
      `[emit-app-manifest] ${MANIFEST_PATH} is stale — run 'node scripts/emit-app-manifest.mjs'`,
    );
    process.exit(1);
  }
  console.log(`[emit-app-manifest] ${MANIFEST_PATH} in sync`);
} else {
  writeFileSync(path, rendered);
  console.log(`[emit-app-manifest] wrote ${MANIFEST_PATH}`);
}
