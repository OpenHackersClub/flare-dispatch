// @flare-dispatch/core — `product-demo` → `signals/v1` adapter.
//
// A failed product-demo chapter is, by definition, "an observability finding
// flare-dispatch collected from a system its read capabilities don't reach" —
// the live, deployed app. So it maps onto the same `signals/v1` narrow waist a
// Datadog/SigNoz collector prints (packages/core/src/signals.ts), except it is
// FIRST-PARTY: flare-dispatch ran the demo itself, so the adapter lives in-tree
// (here + the product-demo run) instead of in `recipes/signals-collectors/`.
//
// --- Two non-negotiable rules this mapper encodes -----------------------------
//
//  1. ONLY assertion failures become signals. A product-demo verdict is an
//     LLM `done` call driving a non-deterministic browser loop, and the run is
//     saturated with infra-flake recovery (CDP re-acquire, wall-clock kills,
//     unparseable stdout). An infra/timeout/unparseable failure is flake or
//     environment — NEVER a code-fix signal. Gating on `failureKind` upstream
//     of emission is what keeps the daily triage PR (and any future heal) from
//     drowning in flake. See the review synthesis in specs/08-self-healing.md.
//
//  2. `narrative` is UNTRUSTED. The demo drives a deployed app that may render
//     attacker-influenced content (user strings, reflected fields); the chapter
//     `narrative` is an LLM SUMMARY of what it saw on-page — a carrier, not a
//     sanitizer. It therefore rides `signals/v1`'s already-fenced `detail`
//     field (which incident/v1 keeps fenced as data, never instructions). The
//     FINGERPRINT (source/title) is built from the operator-authored chapter
//     NAME, never the narrative — so a reworded flake doesn't mint a fresh
//     incidentId and defeat dedup/cooldown downstream (spec § 9.2).
//
// Versioning: this is a producer of `signals/v1`; it adds no new contract.

import { Schema } from "effect";
import {
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  MAX_SIGNAL_URL_CHARS,
  MAX_SIGNALS,
  type SignalT,
} from "./signals";

/**
 * Why a product-demo chapter ended `failed`. Only `"assertion"` (the agent
 * ran the journey and judged the success condition unmet) is a code-fix
 * signal; the rest are flake/environment and are dropped before emission.
 *   - `assertion`   — the agent played the story and the success condition
 *                     was not observable (the app misbehaved).
 *   - `timeout`     — the play loop blew its per-story wall-clock budget.
 *   - `infra`       — the story pipeline itself failed (CDP attach, a dead
 *                     container, a killed step) — nothing to do with the app.
 *   - `unparseable` — the agent produced no parseable verdict (crash / empty).
 */
export const DemoFailureKind = Schema.Literal(
  "assertion",
  "timeout",
  "infra",
  "unparseable",
);
export type DemoFailureKindT = typeof DemoFailureKind.Type;

/**
 * The subset of a product-demo `StoryResult` this mapper reads. Structural so
 * the run's richer `StoryResult` (with GIF/screenshot URIs, timings) satisfies
 * it without coupling core to the run's full output shape.
 */
export interface DemoChapterResult {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly failureKind?: DemoFailureKindT;
  readonly narrative: string;
  readonly replayUri?: string;
  readonly replayJsonUri?: string;
  readonly keyScreenshotUri?: string;
}

export interface DemoSignalContext {
  /** `owner/name` — anchors the signal source + the fingerprint. */
  readonly repo: string;
  /** The deployed URL the demo ran against — context for the triager. */
  readonly deployedUrl: string;
}

const clamp = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/** First non-empty URL, capped — the operator's deep link into the failure. */
const failureUrl = (c: DemoChapterResult): string | undefined => {
  const candidate =
    (c.replayUri ?? "") !== ""
      ? c.replayUri!
      : (c.replayJsonUri ?? "") !== ""
        ? c.replayJsonUri!
        : (c.keyScreenshotUri ?? "") !== ""
          ? c.keyScreenshotUri!
          : "";
  return candidate === "" ? undefined : clamp(candidate, MAX_SIGNAL_URL_CHARS);
};

/**
 * Map a product-demo run's chapters to `signals/v1` — one signal per chapter
 * that failed an ASSERTION (the only heal-worthy class). Infra/timeout/
 * unparseable failures and passing chapters produce nothing.
 *
 * Pure + deterministic (no Date/random/I/O) so it is safe in a run body and
 * unit-testable on fixture chapters without the Browser Run cloud stack — the
 * exact seam a developer reproduces a demo-triggered triage from.
 */
export const storyResultsToSignals = (
  chapters: ReadonlyArray<DemoChapterResult>,
  ctx: DemoSignalContext,
): ReadonlyArray<SignalT> => {
  const source = clamp(`product-demo:${ctx.repo}`, MAX_SIGNAL_SOURCE_CHARS);
  return chapters
    .filter((c) => c.status === "failed" && c.failureKind === "assertion")
    .slice(0, MAX_SIGNALS)
    .map((c) => {
      const url = failureUrl(c);
      // Fingerprint = chapter NAME (operator-authored, stable). The UNTRUSTED
      // narrative goes only in `detail`, after a trusted, deterministic prefix.
      const detail = clamp(
        `Product-demo chapter "${c.name}" failed its journey against ${ctx.deployedUrl}.\n\n` +
          `Agent narrative (UNTRUSTED — page content the LLM summarised):\n${c.narrative}`,
        MAX_SIGNAL_DETAIL_CHARS,
      );
      return {
        source,
        title: clamp(`demo chapter "${c.name}" failed`, MAX_SIGNAL_TITLE_CHARS),
        detail,
        ...(url !== undefined ? { url } : {}),
      } satisfies SignalT;
    });
};
