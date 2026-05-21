// Recipe: browser tests — the `playwright-e2e` Run
//
// Re-exports the canonical run from runs/playwright-e2e.ts (the Dispatcher's
// registered implementation). Copy the runs/playwright-e2e.ts file verbatim
// into your own repo when forking this recipe — the indirection here keeps
// the recipe page in sync with the registered run without duplicating code.
//
// Spec: specs/02-runs.md § 3. DSL: specs/03-dsl.md.

export { playwrightE2E } from "@flare-dispatch/runs/playwright-e2e";
