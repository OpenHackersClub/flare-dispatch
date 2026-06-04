// FlareDispatch Dispatcher — failure-path presentation (issue #85).
//
// A failed run used to post a bare "✗ <run> — execution failed." check-run
// summary, hiding the diagnosis a run may already have built (e.g.
// `product-demo`'s per-chapter table, persisted only to R2). The typed error
// channel now carries that presentation — `AcceptanceFailed.summaryMd` — and
// this module is the dispatcher half: pull the markdown out of the run's
// `Exit` and splice it under the generic line, bounded to GitHub's check-run
// summary limit. Pure + dependency-free so the workflow's failure arm stays
// unit-testable without simulating a Workflow.

import { Cause, Exit, Match, Option } from "effect";
import type { RunError } from "@flare-dispatch/core";

/**
 * GitHub caps a check-run's `output.summary` at 65535 characters — a longer
 * payload 422s the whole update, which would mask the verdict itself.
 * `appendFailureSummary` truncates so the verdict always lands, however
 * chatty the run's summary was.
 */
export const CHECK_SUMMARY_MAX_CHARS = 65_535;

const TRUNCATION_NOTE = "\n\n_… summary truncated to fit the check-run limit._";

/**
 * Extract the run-authored failure markdown from a run's `Exit`, when one is
 * present. `undefined` on success, on a defect/interrupt (`Cause.failureOption`
 * is none — there is no typed failure to read), and on any typed failure that
 * carries no presentation. Only `AcceptanceFailed` carries one today; new
 * error variants opt in by growing a branch here.
 */
export const failureSummaryMd = (
  exit: Exit.Exit<unknown, RunError>,
): string | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => undefined,
        onSome: (failure) =>
          Match.value(failure).pipe(
            Match.tag("AcceptanceFailed", (e) => e.summaryMd),
            Match.orElse(() => undefined),
          ),
      }),
  });

/**
 * Append a run's failure markdown beneath the generic failure line (blank-line
 * separated, so the markdown renders as its own block), truncating the
 * markdown — never the verdict line — to keep the combined summary within
 * `CHECK_SUMMARY_MAX_CHARS`.
 */
export const appendFailureSummary = (
  genericLine: string,
  summaryMd: string | undefined,
): string => {
  if (summaryMd === undefined || summaryMd.trim() === "") return genericLine;
  const combined = `${genericLine}\n\n${summaryMd}`;
  if (combined.length <= CHECK_SUMMARY_MAX_CHARS) return combined;
  const budget =
    CHECK_SUMMARY_MAX_CHARS -
    genericLine.length -
    "\n\n".length -
    TRUNCATION_NOTE.length;
  // A generic line that alone exhausts the limit cannot happen today (it is a
  // single sentence), but guard anyway: drop the summary rather than the line.
  if (budget <= 0) return genericLine.slice(0, CHECK_SUMMARY_MAX_CHARS);
  return `${genericLine}\n\n${summaryMd.slice(0, budget)}${TRUNCATION_NOTE}`;
};
