import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { site } from "../lib/site";

// /llms-full.txt — the full Markdown of every spec concatenated into one fetch,
// so an LLM can ingest the project in a single request. Generated from source
// (the `specs` content collection); each entry's raw `body` is emitted under a
// per-spec header. Side-effect-free.
export const GET: APIRoute = async () => {
  const specs = await getCollection("specs");

  // Stable order by id (e.g. 01-architecture, 02-runs, …; PRD/pm/plan fall out
  // deterministically) so the concatenation is reproducible build-to-build.
  const ordered = specs.sort((a, b) => a.id.localeCompare(b.id));

  const docs = ordered
    .map((entry) => {
      const slug = entry.id.replace(/\.md$/, "").toLowerCase();
      const title =
        (entry.data as { title?: string } | undefined)?.title ?? slug;
      const body = entry.body ?? "";
      return `# ${title}\n\nSource: /docs/${slug}\n\n${body.trim()}`;
    })
    .join("\n\n---\n\n");

  const header = `# ${site.name} — full documentation

> ${site.tagline}

${site.blurb}

Repository: ${site.repo} (${site.status}).
`;

  const out = `${header}\n\n---\n\n${docs}\n`;

  return new Response(out, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
