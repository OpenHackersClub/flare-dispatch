import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const optionalDocSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    date: z.string().optional(),
  })
  .optional();

const specs = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "../../specs",
  }),
  schema: optionalDocSchema,
});

// Per-recipe README files (rendered as prose on the recipe pages).
const recipes = defineCollection({
  loader: glob({
    pattern: "**/README.md",
    base: "../../recipes",
  }),
  schema: optionalDocSchema,
});

export const collections = { specs, recipes };
