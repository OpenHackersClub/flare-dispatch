// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import remarkMermaid from "./src/lib/remark-mermaid.mjs";

const SITE = "https://flaredispatch.openhackers.club";

export default defineConfig({
  site: SITE,
  trailingSlash: "ignore",
  integrations: [mdx(), sitemap()],
  markdown: {
    remarkPlugins: [remarkGfm, remarkMermaid],
    rehypePlugins: [
      rehypeSlug,
      [
        rehypeAutolinkHeadings,
        {
          behavior: "wrap",
          properties: { className: ["heading-anchor"], "data-no-underline": "" },
        },
      ],
    ],
    shikiConfig: {
      themes: {
        light: "vitesse-light",
        dark: "vesper",
      },
      defaultColor: false,
      wrap: true,
    },
  },
  vite: {
    server: { allowedHosts: [".ts.net"] },
    preview: { allowedHosts: [".ts.net"] },
    ssr: {
      noExternal: ["mermaid"],
    },
  },
});
