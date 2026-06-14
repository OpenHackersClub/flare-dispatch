# FlareDispatch log viewer — product-demo walkthrough

Drives the self-hosted per-execution log viewer shipped in #133 (capability-token
API + HTML viewer), #134 (the `logs-url` Action output), and #135 (the D1 step
timeline + run-summary panel). Each `## ` heading below is one story the
`demo-agent` plays over a single recorded CDP session; the run stitches the
captured frames into the walkthrough GIF it posts on the PR.

The workflow points `deployedUrl` at a representative tokened log URL
(`/logs/<execution>?t=<token>`) on the deployed dispatcher — see
`.github/workflows/product-demo-logviewer.yml`.

## open-viewer
The page has loaded the FlareDispatch log viewer for one execution. Confirm the
"FlareDispatch logs" header is visible with the run identifier beside it, and
that a status badge (running, success, or failure) shows in the meta line. Take
a screenshot of the loaded viewer.

## step-timeline
Look at the step timeline — the row of step chips, each with a small coloured
dot (green = success, red = failure, blue = running) and a duration. Confirm the
chips render in execution order and that the dots reflect each step's outcome.
This is the D1-backed timeline from #135 that replaces the old truncated
Workflows step output.

## run-summary
Find the run-summary panel near the top (the verdict line plus a collapsible
summary). Expand the collapsible summary if it is collapsed, and confirm the
run's markdown summary renders inside it.

## expand-log
Open one of the per-command log sections (the collapsible `<details>` blocks,
each labelled with its command and byte size). Confirm the full, untruncated
output renders as numbered lines, and that any stderr lines are tinted red —
this is the complete log from R2, not the `…truncated…` Workflows view.

## filter-and-stderr
Click into the "filter lines…" search box and type a word you can see in the
log to narrow the visible lines. Then toggle the "stderr only" checkbox and
confirm the view collapses to just the error lines. Clear the filter when done.
