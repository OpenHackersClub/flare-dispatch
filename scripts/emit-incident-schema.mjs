// Emit the JSON Schema artifact for the `incident/v1` contract.
//
// `schemas/incident.v1.schema.json` is the language-agnostic, committed mirror
// of the canonical Effect schema in `packages/core/src/incident.ts`. A
// non-TypeScript synthesizer or agent harness can validate the pack against
// this file without importing the TS package.
//
// Source of truth: `packages/core/src/incident.ts`. This script is plain ESM so
// it runs under bare `node` in CI (alongside `emit-signals-schema.mjs` /
// `sync-recipes.mjs`). The schema below is hand-mirrored from the Effect schema;
// `packages/core/src/incident.test.ts` asserts the committed JSON's numeric caps
// equal the EXPORTED cap constants, so the two can't silently drift.
//
// Write mode (default): (re)write `schemas/incident.v1.schema.json`.
// Check mode (`--check`): exit 1 if the committed file is stale (CI gate).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Caps — MUST equal the exports in packages/core/src/incident.ts. The
// packages/core incident test fails CI if these diverge from the TS constants.
const MAX_INCIDENT_CI_FAILURES = 20;
const MAX_INCIDENT_SUSPECT_FILES = 50;
const MAX_INCIDENT_LOGTAIL_CHARS = 4_000;
const MAX_INCIDENT_TEXT_CHARS = 2_000;
const MAX_INCIDENT_SHORT_CHARS = 200;
const MAX_INCIDENT_PATH_CHARS = 400;
const MAX_INCIDENT_URL_CHARS = 1_000;

// signals/v1 caps (incident embeds a signals array) — mirrored from signals.ts.
const MAX_SIGNALS = 50;
const MAX_SIGNAL_SOURCE_CHARS = 120;
const MAX_SIGNAL_TITLE_CHARS = 200;
const MAX_SIGNAL_DETAIL_CHARS = 2_000;
const MAX_SIGNAL_URL_CHARS = 1_000;

const SCHEMA_PATH = "schemas/incident.v1.schema.json";

const str = (maxLength, description) => ({ type: "string", maxLength, description });

/** The hand-mirrored JSON Schema (draft 2020-12) for `incident/v1`. */
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openhackers.club/flare-dispatch/schemas/incident.v1.schema.json",
  title: "flare-dispatch incident/v1",
  description:
    "The bounded fix-side context pack a self-heal coding agent receives. Canonical contract: packages/core/src/incident.ts. Spec: specs/08-self-healing.md § 5. SECURITY: `signals` and `ciFailures[].logTail` are attacker-controlled telemetry — see § 10.1.",
  "x-flare-dispatch-contract-version": "v1",
  "x-flare-dispatch-source": "packages/core/src/incident.ts",
  type: "object",
  additionalProperties: false,
  required: ["incidentId", "class", "repo"],
  properties: {
    contractVersion: { const: "v1" },
    incidentId: str(MAX_INCIDENT_SHORT_CHARS, "Dedup identity of the failure (not the alert delivery)."),
    class: { type: "string", enum: ["ci", "application"] },
    repo: str(MAX_INCIDENT_SHORT_CHARS, "owner/name."),
    suspectRef: {
      type: "object",
      additionalProperties: false,
      required: ["base", "head"],
      properties: {
        base: str(MAX_INCIDENT_PATH_CHARS, "Suspect range base SHA."),
        head: str(MAX_INCIDENT_PATH_CHARS, "Suspect range head SHA."),
        confidence: { type: "number", description: "0–1 correlation confidence." },
        advisory: { type: "boolean", description: "True when the correlation is low-confidence." },
      },
    },
    diagnosis: {
      type: "object",
      additionalProperties: false,
      required: ["title", "area", "diagnosis", "suggestedFix"],
      properties: {
        title: str(MAX_INCIDENT_TEXT_CHARS, "Short title naming the failure."),
        area: str(MAX_INCIDENT_TEXT_CHARS, "Where it failed."),
        diagnosis: str(MAX_INCIDENT_TEXT_CHARS, "Most likely root cause."),
        suggestedFix: str(MAX_INCIDENT_TEXT_CHARS, "Concrete suggested next step."),
      },
    },
    signals: {
      type: "array",
      maxItems: MAX_SIGNALS,
      description: "Caller-supplied observability findings (signals/v1) — ATTACKER-CONTROLLED.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "title", "detail"],
        properties: {
          source: str(MAX_SIGNAL_SOURCE_CHARS, "Which system produced the signal."),
          title: str(MAX_SIGNAL_TITLE_CHARS, "Short title naming the error."),
          detail: str(MAX_SIGNAL_DETAIL_CHARS, "Enough detail for a model to triage."),
          url: str(MAX_SIGNAL_URL_CHARS, "Optional deep link."),
          count: { type: "number", description: "Optional occurrence count." },
        },
      },
    },
    ciFailures: {
      type: "array",
      maxItems: MAX_INCIDENT_CI_FAILURES,
      description: "First-party CI failures — `logTail` is ATTACKER-INFLUENCEABLE.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name", "conclusion"],
        properties: {
          kind: { type: "string", enum: ["actions", "pages", "run-step"] },
          name: str(MAX_INCIDENT_TEXT_CHARS, "Failing check/job name."),
          conclusion: str(MAX_INCIDENT_SHORT_CHARS, "Conclusion (e.g. failure)."),
          command: str(MAX_INCIDENT_TEXT_CHARS, "The exact failing command (CI-class repro)."),
          logTail: str(MAX_INCIDENT_LOGTAIL_CHARS, "Bounded stderr/stdout tail from R2."),
          url: str(MAX_INCIDENT_URL_CHARS, "Link to the failure."),
        },
      },
    },
    suspectFiles: {
      type: "array",
      maxItems: MAX_INCIDENT_SUSPECT_FILES,
      description: "Files to inspect — from changed-files (CI) or a stack frame (app).",
      items: str(MAX_INCIDENT_PATH_CHARS, "Repo-relative path."),
    },
    repro: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["command", "derived", "none"] },
        command: str(MAX_INCIDENT_TEXT_CHARS, "Exact command to re-run."),
        note: str(MAX_INCIDENT_TEXT_CHARS, "Guidance when derived."),
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
      `[emit-incident-schema] ${SCHEMA_PATH} is missing — run 'node scripts/emit-incident-schema.mjs'`,
    );
    process.exit(1);
  }
  if (actual !== rendered) {
    console.error(
      `[emit-incident-schema] ${SCHEMA_PATH} is stale — run 'node scripts/emit-incident-schema.mjs'`,
    );
    process.exit(1);
  }
  console.log(`[emit-incident-schema] ${SCHEMA_PATH} in sync`);
} else {
  writeFileSync(path, rendered);
  console.log(`[emit-incident-schema] wrote ${SCHEMA_PATH}`);
}
