import type { APIRoute } from "astro";
import { site } from "../lib/site";
import { nav } from "../lib/nav";
import { recipes } from "../lib/recipes";

// /llms.txt — Markdown index of the site for LLM consumption, per the llms.txt
// spec (https://llmstxt.org). Generated from source (site/nav/recipes), not
// hand-maintained: an H1, a one-line blockquote summary, then curated links.
export const GET: APIRoute = ({ site: origin }) => {
  const base = (origin ?? new URL("https://flare-dispatch.openhackers.club")).origin;
  const abs = (path: string): string => `${base}${path}`;

  const sections = nav
    .map((section) => {
      const items = section.items
        .map((item) => {
          const url = abs(`/docs/${item.slug}`);
          const blurb = item.blurb ? `: ${item.blurb}` : "";
          return `- [${item.label}](${url})${blurb}`;
        })
        .join("\n");
      return `## ${section.title}\n\n${items}`;
    })
    .join("\n\n");

  const recipeLinks = recipes
    .map((recipe) => {
      const url = abs(`/recipes/${recipe.slug}`);
      return `- [${recipe.label}](${url}): ${recipe.useCase} (${recipe.mode} mode).`;
    })
    .join("\n");

  const body = `# ${site.name}

> ${site.tagline}

${site.blurb}

${sections}

## Recipes

Worked examples of wiring real CI use cases onto ${site.name}.

${recipeLinks}

## Source

- [GitHub repository](${site.repo}): source, runs, and recipes (${site.status}).
`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
