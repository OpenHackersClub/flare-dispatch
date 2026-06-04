// Tests for the completion-notify email renderer.

import { describe, expect, it } from "vitest";
import { renderResultEmail } from "./notify";

const base = {
  run: "playwright-demo",
  executionId: "01J0EXEC",
  repo: "owner/name",
  sha: "abc123def456",
} as const;

describe("renderResultEmail", () => {
  it("renders a success with output URLs as links", () => {
    const { subject, html, text } = renderResultEmail({
      ...base,
      status: "success",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
      output: {
        videoUri: "https://r2.example/demo-bundle.tar.zst",
        logUri: "https://r2.example/playwright.log",
        exitCode: 0,
        durationMs: 1234,
      },
    });

    expect(subject).toBe("[FlareDispatch] playwright-demo — ✓ succeeded");
    // URL output fields become anchors with humanized labels.
    expect(html).toContain('<a href="https://r2.example/demo-bundle.tar.zst">');
    expect(html).toContain("Video"); // videoUri → "Video"
    expect(html).toContain("Log"); // logUri → "Log"
    expect(html).toContain("Exit Code"); // exitCode → "Exit Code"
    expect(html).toContain("View step logs in Cloudflare");
    // Plain-text alternative carries the same data.
    expect(text).toContain("SUCCEEDED");
    expect(text).toContain("Video: https://r2.example/demo-bundle.tar.zst");
    expect(text).toContain("Step logs: https://dash.cloudflare.com");
  });

  it("renders a failure without output", () => {
    const { subject, html, text } = renderResultEmail({
      ...base,
      status: "failure",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
    });

    expect(subject).toBe("[FlareDispatch] playwright-demo — ✗ failed");
    expect(html).toContain("failed before producing output");
    expect(html).toContain("✗ Failed");
    expect(text).toContain("FAILED");
  });

  it("renders the run-authored failure summary on the failure branch", () => {
    const { html, text } = renderResultEmail({
      ...base,
      status: "failure",
      detailsUrl: "https://dash.cloudflare.com/x/instance/01J0EXEC",
      failureDisplay: "# product-demo — 0/2 chapters passed\n| landing | ❌ fail |",
    });

    // The markdown is shown verbatim (escaped) in a <pre> block…
    expect(html).toContain("<pre");
    expect(html).toContain("0/2 chapters passed");
    expect(html).toContain("| landing | ❌ fail |");
    // …replacing the generic "no output" paragraph.
    expect(html).not.toContain("failed before producing output");
    // Plain-text alternative carries the same markdown.
    expect(text).toContain("0/2 chapters passed");
  });

  it("HTML-escapes the failure summary (caller-influenced markdown)", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "failure",
      failureDisplay: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("ignores failureDisplay on a success", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { exitCode: 0 },
      failureDisplay: "should not render",
    });
    expect(html).not.toContain("should not render");
  });

  it("HTML-escapes caller-influenced output values", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { note: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the details link when no detailsUrl is given", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: { exitCode: 0 },
    });
    expect(html).not.toContain("View step logs");
  });

  it("ignores a non-object output (no result rows)", () => {
    const { html } = renderResultEmail({
      ...base,
      status: "success",
      output: "just a string",
    });
    expect(html).not.toContain("Results");
  });
});
