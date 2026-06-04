// Tests for the failure-path presentation extraction (issue #85).
//
// `failureSummaryMd` pulls the run-authored markdown out of a run's `Exit`
// (only `AcceptanceFailed.summaryMd` carries one today); `appendFailureSummary`
// splices it under the generic "execution failed" line, bounded to GitHub's
// 65535-char check-run summary limit.

import { Cause, Exit, FiberId } from "effect";
import { describe, expect, it } from "vitest";
import { AcceptanceFailed, ExecFailed } from "@flare-dispatch/core";
import {
  CHECK_SUMMARY_MAX_CHARS,
  appendFailureSummary,
  failureSummaryMd,
} from "./failure-summary";

describe("failureSummaryMd", () => {
  it("extracts the markdown from a failed Exit carrying AcceptanceFailed.summaryMd", () => {
    const exit = Exit.fail(
      new AcceptanceFailed({
        exitCode: 1,
        summaryMd: "# product-demo — 0/2 chapters passed",
      }),
    );
    expect(failureSummaryMd(exit)).toBe(
      "# product-demo — 0/2 chapters passed",
    );
  });

  it("is undefined for an AcceptanceFailed without summaryMd", () => {
    expect(
      failureSummaryMd(Exit.fail(new AcceptanceFailed({ exitCode: 1 }))),
    ).toBeUndefined();
  });

  it("is undefined for other typed run errors", () => {
    expect(
      failureSummaryMd(
        Exit.fail(new ExecFailed({ exitCode: 7, stderrTail: "boom" })),
      ),
    ).toBeUndefined();
  });

  it("is undefined for a success Exit", () => {
    expect(failureSummaryMd(Exit.succeed({ ok: true }))).toBeUndefined();
  });

  it("is undefined for a defect (Cause.die — failureOption is none)", () => {
    expect(
      failureSummaryMd(Exit.failCause(Cause.die("unexpected"))),
    ).toBeUndefined();
  });

  it("is undefined for an interrupt", () => {
    expect(
      failureSummaryMd(Exit.failCause(Cause.interrupt(FiberId.none))),
    ).toBeUndefined();
  });
});

describe("appendFailureSummary", () => {
  const generic = "✗ product-demo — execution failed.";

  it("returns the generic line untouched when there is no summary", () => {
    expect(appendFailureSummary(generic, undefined)).toBe(generic);
  });

  it("returns the generic line untouched for a whitespace-only summary", () => {
    expect(appendFailureSummary(generic, "  \n ")).toBe(generic);
  });

  it("appends the summary beneath the generic line, blank-line separated", () => {
    expect(appendFailureSummary(generic, "| Chapter | Result |")).toBe(
      `${generic}\n\n| Chapter | Result |`,
    );
  });

  it("truncates an oversized summary so the total stays within GitHub's limit", () => {
    const huge = "x".repeat(CHECK_SUMMARY_MAX_CHARS + 1000);
    const combined = appendFailureSummary(generic, huge);
    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
    expect(combined.startsWith(`${generic}\n\n`)).toBe(true);
    expect(combined).toContain("summary truncated");
  });

  it("keeps a within-limit summary verbatim (no truncation note)", () => {
    const md = "y".repeat(1000);
    const combined = appendFailureSummary(generic, md);
    expect(combined).toBe(`${generic}\n\n${md}`);
    expect(combined).not.toContain("summary truncated");
  });
});
