# FlareDispatch product-demo viewer — product-demo walkthrough

Drives the self-hosted product-demo viewer shipped in #155 (`/demos/:execution`):
a hero rrweb replay over a per-chapter gallery, each chapter its own animated
GIF + narrative, with the gallery driving the single hero player. Each `## `
heading below is one story the `demo-agent` plays over a single recorded CDP
session; the run stitches the captured frames into the walkthrough GIF and the
per-chapter GIFs it posts on the PR — so this demo dogfoods the very page it
walks through.

The workflow points `deployedUrl` at a representative tokened viewer URL
(`/demos/<execution>?t=<token>`) on the deployed dispatcher — see
`.github/workflows/product-demo-pages.yml`.

## open-viewer
The page has loaded the FlareDispatch product-demo viewer for one execution.
Confirm the "FlareDispatch product demo" header is visible with the run
identifier beside it, and that the "Walkthrough" heading sits above a video
player area. Take a screenshot of the loaded page.

## hero-replay
Look at the hero player under "Walkthrough" — an embedded rrweb session replay
with a caption reading "Now playing:" and a chapter name. Confirm the player has
loaded (it shows the recorded page, not a blank box) and that the caption names
the active chapter.

## chapter-gallery
Scroll to the "Chapters" section — a grid of cards, each showing an animated GIF
of that chapter, a numbered title, a pass/fail badge, and a one-line
description. Confirm several chapter cards render with their GIF previews and
that the "N/N passed" count shows beside the heading.

## play-a-chapter
Click a chapter card other than the one currently playing. Confirm the hero
player above jumps to that chapter's replay (the caption updates to the clicked
chapter's name) and that the clicked card gains a highlighted "now playing"
state. This is the gallery-drives-one-player behaviour from #155.

## open-full-screen
On any chapter card, find the "Open full-screen ↗" link and confirm it points at
that chapter's standalone replay (it opens the rrweb player in a new tab).
Confirm the link is present without leaving the viewer.
