// Emit the JSON Schema artifact for the `signals/v1` contract.
//
// `schemas/signals.v1.schema.json` is the language-agnostic, committed mirror
// of the canonical Effect schema in `packages/core/src/signals.ts`. A
// consumer-side collector/adapter written in ANY language (a shell one-liner,
// a Go binary, a Python lambda) can validate its output against this file
// without depending on the TypeScript package — the dispatcher stays the
// narrow waist, the adapters live consumer-side.
//
// Source of truth: `packages/core/src/signals.ts`. This script is intentionally
// plain ESM so it runs under bare `node` in CI (alongside `sync-recipes.mjs`,
// which can't import the TS contract). The schema below is therefore
// hand-mirrored from the Effect schema; `packages/core/src/signals.test.ts`
// asserts the committed JSON's numeric caps equal the EXPORTED cap constants,
// so the two can't silently drift even though this file restates them.
//
// Write mode (default): (re)write `schemas/signals.v1.schema.json`.
// Check mode (`--check`): exit 1 if the committed file is stale (CI gate).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Caps — MUST equal the exports in packages/core/src/signals.ts. The
// packages/core signals test fails CI if these diverge from the TS constants.
const MAX_SIGNALS = 50;
const MAX_SIGNAL_SOURCE_CHARS = 120;
const MAX_SIGNAL_TITLE_CHARS = 200;
const MAX_SIGNAL_DETAIL_CHARS = 2_000;
const MAX_SIGNAL_URL_CHARS = 1_000;

const SCHEMA_PATH = "schemas/signals.v1.schema.json";

/** The hand-mirrored JSON Schema (draft 2020-12) for `signals/v1`. */
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openhackers.club/flare-dispatch/schemas/signals.v1.schema.json",
  title: "flare-dispatch signals/v1",
  description:
    "Caller-supplied observability signals. Canonical contract: packages/core/src/signals.ts. Producer contract + versioning policy: specs/02-runs.md § Signals.",
  "x-flare-dispatch-contract-version": "v1",
  "x-flare-dispatch-source": "packages/core/src/signals.ts",
  type: "array",
  maxItems: MAX_SIGNALS,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["source", "title", "detail"],
    properties: {
      source: {
        type: "string",
        maxLength: MAX_SIGNAL_SOURCE_CHARS,
        description:
          "Which system produced the signal. Convention: vendor-or-surface[:scope].",
      },
      title: {
        type: "string",
        maxLength: MAX_SIGNAL_TITLE_CHARS,
        description: "Short title naming the error.",
      },
      detail: {
        type: "string",
        maxLength: MAX_SIGNAL_DETAIL_CHARS,
        description: "Enough detail for a model to triage (message, context, window).",
      },
      url: {
        type: "string",
        maxLength: MAX_SIGNAL_URL_CHARS,
        description: "Optional deep link into the producing system.",
      },
      count: {
        type: "number",
        description: "Optional occurrence count over the caller's window.",
      },
    },
  },
};

const rendered = `${JSON.stringify(schema, null, 2)}\n`;
const check = process.argv.includes("--check");
const path = resolve(process.cwd(), SCHEMA_PATH);

if (check) {
  let actual;
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    console.error(
      `[emit-signals-schema] ${SCHEMA_PATH} is missing — run 'node scripts/emit-signals-schema.mjs'`,
    );
    process.exit(1);
  }
  if (actual !== rendered) {
    console.error(
      `[emit-signals-schema] ${SCHEMA_PATH} is stale — run 'node scripts/emit-signals-schema.mjs'`,
    );
    process.exit(1);
  }
  console.log(`[emit-signals-schema] ${SCHEMA_PATH} in sync`);
} else {
  writeFileSync(path, rendered);
  console.log(`[emit-signals-schema] wrote ${SCHEMA_PATH}`);
}
