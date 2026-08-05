# FlareDispatch log viewer — product-demo walkthrough

Drives the self-hosted per-execution log viewer shipped in #133 (capability-token
API + HTML viewer), #134 (the `logs-url` Action output), and #135 (the D1 step
timeline + run-summary panel). Each `## ` heading below is one story the
`demo-agent` plays over a single recorded CDP session; the run stitches the
captured frames into the walkthrough GIF it posts on the PR.

The workflow points `deployedUrl` at a representative tokened log URL
(`/logs/<execution>?t=<token>`) on the deployed dispatcher — see
`.github/workflows/product-demo-logviewer.yml`. Point it at a **logs-rich,
retained execution** (e.g. a recent `offload-test` / `playwright-e2e` run that
has real per-command output and some stderr), NOT a worker-only run — the
`expand-log` and `filter-and-stderr` chapters need actual command logs to show.

Each chapter is a quick visual confirmation, not an exploration. As soon as you
have confirmed what the chapter asks for, signal `done` with status `pass` and a
one-line narrative — do not keep clicking around. If the page is missing a
control the chapter expects, confirm the closest available state and finish
rather than hunting for it.

## open-viewer
The page has loaded the FlareDispatch log viewer for one execution. Confirm the
"FlareDispatch logs" header is visible with the run identifier beside it, and
that a status badge (running, success, or failure) shows in the meta line. Take
one screenshot of the loaded viewer, then signal done — this is just the landing
confirmation.

## step-timeline
Look at the step timeline — the row of step chips, each with a small coloured
dot (green = success, red = failure, blue = running) and a duration. Confirm the
chips render in execution order and that the dots reflect each step's outcome,
then signal done. This is the D1-backed timeline from #135 that replaces the old
truncated Workflows step output.

## run-summary
Find the run-summary panel near the top — the verdict line plus a collapsible
summary section. Open the summary by clicking its disclosure control (the
`▸`/`▾` toggle or the "Summary"/"Details" label), NOT the status/verdict badge
(`success`/`failure`) — the badge is a label, not a control, and clicking it
does nothing. Once the markdown summary is visible (or already was), confirm it
renders and signal done.

## expand-log
Open one of the per-command log sections (the collapsible `<details>` blocks,
each labelled with its command and byte size) by clicking its summary line.
Confirm the full, untruncated output renders as numbered lines, and that any
stderr lines are tinted red — this is the complete log from R2, not the
`…truncated…` Workflows view. Confirm one expanded section, then signal done; you
do not need to open every section.

## filter-and-stderr
Click into the "filter lines…" search box and type a word you can see in the
log to narrow the visible lines; confirm the view narrows. Then toggle the
"stderr only" checkbox and confirm the view collapses to just the error lines.
Clear the filter, then signal done.
