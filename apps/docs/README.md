# @flaredispatch/docs

Landing page + documentation site for FlareDispatch.

Built with [Astro](https://astro.build). Content is sourced from the
monorepo-root `specs/` and `recipes/` directories via
[Astro Content Collections](https://docs.astro.build/en/guides/content-collections/).

## Develop

From this directory:

```sh
pnpm install
pnpm dev
```

Then open <http://127.0.0.1:4321>.

## Build

```sh
pnpm build
pnpm preview
```

Run `pnpm build` from this directory — recipe source files are read from
`../../recipes` relative to the build's working directory.

## Layout

```
src/
├── components/    — Header, Sidebar, RecipeSidebar, MermaidRunner, etc.
├── layouts/       — BaseLayout (landing) + DocLayout (spec pages)
├── lib/
│   ├── nav.ts            — spec sidebar configuration
│   ├── recipes.ts        — recipe catalog metadata
│   ├── recipe-files.ts   — build-time reader for recipe source files
│   ├── site.ts           — brand/site constants
│   └── remark-mermaid.mjs — mermaid block extraction (rendered client-side)
├── pages/
│   ├── index.astro       — landing page
│   ├── docs/
│   │   ├── index.astro   — specs hub
│   │   └── [...slug].astro — dynamic spec page
│   └── recipes/
│       ├── index.astro   — recipes hub
│       └── [slug].astro  — recipe page (README + source files)
├── styles/
│   └── global.css        — design system
└── content.config.ts     — content collection loaders
```

## Content collections

`src/content.config.ts` defines two collections:

- **`specs`** — globs `**/*.md` from `../../specs`. Each file becomes a page
  under `/docs/<slug>`. Frontmatter is optional; titles fall back to the
  sidebar label or first H1. To add a spec, drop a `.md` file in `specs/` and
  add an entry to `src/lib/nav.ts`.
- **`recipes`** — globs `**/README.md` from `../../recipes`, so a recipe's
  README renders as prose on its page.

Recipe source files (`ci.yml`, `*.run.ts`) are not markdown — they are read
from disk at build time by `src/lib/recipe-files.ts` and rendered with the
`<Code>` component. To add a recipe, add an entry to `src/lib/recipes.ts`.

## Mermaid

`remark-mermaid.mjs` rewrites fenced ` ```mermaid ` blocks into
`<div class="mermaid-source" data-source="...">` wrappers. `MermaidRunner.astro`
lazy-loads `mermaid` on the client and renders them into SVG, re-rendering on
theme change.

## Theme

CSS variables + `data-theme` attribute on `<html>`. Light = "paper" (warm
off-white), dark = "terminal" (near-black). Toggle persists in `localStorage`
under `flaredispatch:theme`.
