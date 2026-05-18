/**
 * Sidebar navigation for the docs site.
 * Each entry's `slug` matches the lowercased content-collection id under specs/.
 */

export type NavItem = {
  slug: string;
  label: string;
  blurb?: string;
};

export type NavSection = {
  number: string;
  title: string;
  items: NavItem[];
};

export const nav: NavSection[] = [
  {
    number: "00",
    title: "Overview",
    items: [
      {
        slug: "prd",
        label: "Product Requirements",
        blurb: "Problem, who needs this, value proposition, non-goals, roadmap.",
      },
    ],
  },
  {
    number: "01",
    title: "Specs",
    items: [
      {
        slug: "01-architecture",
        label: "Architecture",
        blurb: "Components, per-execution lifecycle, storage, fan-out, platform limits.",
      },
      {
        slug: "02-runs",
        label: "Runs",
        blurb: "Run catalog — inputs, outputs, and CF primitives for each shipped run.",
      },
      {
        slug: "03-dsl",
        label: "DSL",
        blurb: "Effect-TS DSL surface — defineRun, step, sandbox, browser, cache, artifact.",
      },
      {
        slug: "04-gha-integration",
        label: "GHA Integration",
        blurb: "Two trigger modes (Action / Webhook), HMAC auth, check-runs callback.",
      },
      {
        slug: "05-byoc",
        label: "BYOC Deployment",
        blurb: "Bindings, secrets, wrangler config, GitHub App setup, local dev.",
      },
      {
        slug: "06-cost",
        label: "Cost",
        blurb: "Cost model, worked estimates, head-to-head with GHA pricing.",
      },
    ],
  },
  {
    number: "02",
    title: "Project",
    items: [
      {
        slug: "pm/plan",
        label: "Roadmap & V0 Plan",
        blurb: "Delivery roadmap (V0–V4) and the 7-PR V0 walking-skeleton build plan.",
      },
    ],
  },
];

export const allItems = (): NavItem[] =>
  nav.flatMap((section) => section.items);

export const findNext = (slug: string): NavItem | undefined => {
  const flat = allItems();
  const idx = flat.findIndex((i) => i.slug === slug);
  return idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : undefined;
};

export const findPrev = (slug: string): NavItem | undefined => {
  const flat = allItems();
  const idx = flat.findIndex((i) => i.slug === slug);
  return idx > 0 ? flat[idx - 1] : undefined;
};
