// FlareDispatch Dispatcher — completion-notify email rendering.
//
// `renderResultEmail` turns an execution's terminal state — run name, verdict,
// repo/sha, the Cloudflare Workflows details link, and the run's *output*
// object — into the `{ subject, html, text }` the `email` capability sends to
// the dispatch's `notify.emails` list. The output object is where a run's
// shareable results live: `playwright-demo` returns `videoUri` + `logUri`,
// `deploy-smoke` a target URL, `offload-test` a `logUri`. Any output field
// whose value is an `http(s)` URL is rendered as a clickable link (artifact /
// demo / log), so a stakeholder clicks straight through from the email.
//
// Rendering is pure + dependency-free (no MIME — the `send_email` binding
// builds that) and HTML-escapes every interpolated value: a run's output is
// caller-influenced data, so a `<script>`-bearing field must not execute in a
// webmail client.
//
// Spec: specs/04-gha-integration.md § Notifications.

/** The terminal verdict — mirrors the GitHub check-run conclusion family. */
export type NotifyStatus = "success" | "failure";

export type RenderResultEmailInput = {
  readonly run: string;
  readonly status: NotifyStatus;
  readonly executionId: string;
  readonly repo: string;
  readonly sha: string;
  /** Cloudflare Workflows instance page, when `CLOUDFLARE_ACCOUNT_ID` is set. */
  readonly detailsUrl?: string;
  /**
   * The run's output object (the `Exit` success value), or `undefined` on a
   * failed run (no output produced). Rendered as a labelled link/value table.
   */
  readonly output?: unknown;
  /**
   * Run-authored failure markdown (`AcceptanceFailed.summaryMd` — the same
   * text the check-run failure summary embeds, issue #85). Rendered escaped
   * inside a `<pre>` block on the failure branch only; ignored on success.
   */
  readonly failureDisplay?: string;
};

export type RenderedEmail = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

/** Minimal HTML-escape for interpolated text + attribute values. */
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An `http(s)` URL is the only value we turn into a link. */
const isHttpUrl = (v: unknown): v is string =>
  typeof v === "string" && /^https?:\/\//.test(v);

/**
 * Humanize an output key for a label: `videoUri` → "Video", `logUri` → "Log",
 * `previewUrl` → "Preview", `exitCode` → "Exit code".
 */
const humanizeKey = (key: string): string => {
  const stripped = key.replace(/(Uri|Url)$/i, "");
  const spaced = stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Render a single output value to an HTML cell. */
const valueCellHtml = (value: unknown): string => {
  if (isHttpUrl(value)) {
    return `<a href="${esc(value)}">${esc(value)}</a>`;
  }
  if (typeof value === "string") return esc(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return esc(String(value));
  }
  return `<code>${esc(JSON.stringify(value))}</code>`;
};

/** Flatten an output object into ordered `[label, value]` rows. */
const outputRows = (output: unknown): readonly [string, unknown][] => {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return [];
  }
  return Object.entries(output as Record<string, unknown>).map(
    ([k, v]) => [humanizeKey(k), v] as const,
  );
};

const statusBadge = (status: NotifyStatus): { label: string; color: string } =>
  status === "success"
    ? { label: "✓ Succeeded", color: "#1a7f37" }
    : { label: "✗ Failed", color: "#cf222e" };

export const renderResultEmail = (
  input: RenderResultEmailInput,
): RenderedEmail => {
  const badge = statusBadge(input.status);
  const rows = input.status === "success" ? outputRows(input.output) : [];
  // The run-authored failure markdown, failure branch only. Caller-influenced
  // text — always escaped, shown as-is in a <pre> (no markdown rendering in
  // email; the verbatim table/text is still far more useful than the generic
  // "no output" line it replaces).
  const failureDisplay =
    input.status === "failure" &&
    input.failureDisplay !== undefined &&
    input.failureDisplay.trim() !== ""
      ? input.failureDisplay
      : undefined;

  const subject = `[FlareDispatch] ${input.run} — ${input.status === "success" ? "✓ succeeded" : "✗ failed"}`;

  // --- HTML body --------------------------------------------------------------
  const metaRows: [string, string][] = [
    ["Run", input.run],
    ["Repository", input.repo],
    ["Commit", input.sha],
    ["Execution", input.executionId],
  ];
  const metaHtml = metaRows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#57606a;">${esc(k)}</td><td style="padding:4px 0;"><code>${esc(v)}</code></td></tr>`,
    )
    .join("");

  const resultsHtml =
    rows.length > 0
      ? `<h3 style="margin:20px 0 8px;font-size:15px;">Results</h3><table style="border-collapse:collapse;font-size:14px;">${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#57606a;vertical-align:top;">${esc(label)}</td><td style="padding:4px 0;">${valueCellHtml(value)}</td></tr>`,
          )
          .join("")}</table>`
      : input.status === "failure"
        ? failureDisplay !== undefined
          ? `<h3 style="margin:20px 0 8px;font-size:15px;">Failure summary</h3><pre style="margin:0;padding:12px;background:#f6f8fa;border-radius:6px;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;">${esc(failureDisplay)}</pre>`
          : `<p style="font-size:14px;color:#57606a;">The run failed before producing output.${
              input.detailsUrl !== undefined
                ? ` See the <a href="${esc(input.detailsUrl)}">step logs</a> for the cause.`
                : ""
            }</p>`
        : "";

  const detailsHtml =
    input.detailsUrl !== undefined
      ? `<p style="margin:16px 0 0;font-size:14px;"><a href="${esc(input.detailsUrl)}">View step logs in Cloudflare →</a></p>`
      : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;">
<table style="max-width:600px;border-collapse:collapse;">
<tr><td>
<span style="display:inline-block;padding:4px 10px;border-radius:6px;background:${badge.color};color:#fff;font-size:13px;font-weight:600;">${esc(badge.label)}</span>
<h2 style="margin:12px 0 4px;font-size:18px;">${esc(input.run)}</h2>
<table style="border-collapse:collapse;font-size:14px;margin-top:8px;">${metaHtml}</table>
${resultsHtml}
${detailsHtml}
<p style="margin:24px 0 0;font-size:12px;color:#8c959f;">Sent by FlareDispatch.</p>
</td></tr>
</table>
</body></html>`;

  // --- Plain-text alternative -------------------------------------------------
  const textLines: string[] = [
    `FlareDispatch — ${input.run} — ${input.status === "success" ? "SUCCEEDED" : "FAILED"}`,
    "",
    `Repository: ${input.repo}`,
    `Commit:     ${input.sha}`,
    `Execution:  ${input.executionId}`,
  ];
  if (rows.length > 0) {
    textLines.push("", "Results:");
    for (const [label, value] of rows) {
      textLines.push(
        `  ${label}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`,
      );
    }
  } else if (input.status === "failure") {
    if (failureDisplay !== undefined) {
      textLines.push("", "Failure summary:", "", failureDisplay);
    } else {
      textLines.push("", "The run failed before producing output.");
    }
  }
  if (input.detailsUrl !== undefined) {
    textLines.push("", `Step logs: ${input.detailsUrl}`);
  }
  const text = textLines.join("\n");

  return { subject, html, text };
};
