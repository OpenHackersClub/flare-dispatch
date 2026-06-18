# Product demo — story script

The worked `storiesMarkdown` script `ci.yml` ships by default. Each level-2
heading (`## `) below is ONE chapter: the heading is the chapter name, and the
prose beneath it (down to the next `## `) is what the `demo-agent` plays over a
single recorded CDP session. Everything above the first `## ` — this title and
paragraph — is preamble the agent never sees.

Edit this file like documentation; the run parses it into the same
`{ name, prose }` list the structured `stories` array produces. Keep chapter
names unique and don't let one be a hyphen-prefix of another (`sign` vs
`sign-in`) — names become rrweb chapter markers AND the per-chapter GIF frame
prefix.

## Sign in
Open the site, click **Sign in**, and log in with the demo account. Confirm you
land on the dashboard and the account menu shows the signed-in user.

## Create a project
From the dashboard, create a new project named "Demo". Confirm the project opens
on its empty state and the "Add your first item" call-to-action is visible.

## Invite a teammate
Open the project's members area, invite `teammate@example.com`, and confirm a
pending-invite chip appears next to their email.
