/**
 * Build-time reader for recipe source files. The `recipes/` directory lives at
 * the monorepo root, outside the docs Vite project, so it is read from disk
 * with `node:fs` rather than imported. Resolution tolerates the build running
 * from either the docs package or the monorepo root.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const candidates = [
  resolve(process.cwd(), "../../recipes"),
  resolve(process.cwd(), "recipes"),
  resolve(process.cwd(), "../recipes"),
];

const recipesRoot = candidates.find((dir) =>
  existsSync(resolve(dir, "README.md")),
);

export function readRecipeFile(slug: string, name: string): string {
  if (!recipesRoot) {
    throw new Error(
      `recipes/ directory not found (looked in: ${candidates.join(", ")})`,
    );
  }
  return readFileSync(resolve(recipesRoot, slug, name), "utf8");
}
