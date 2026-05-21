// Recipe: sharded test matrix — the `matrix-fanout` Run
//
// Re-exports the canonical run from runs/matrix-fanout.ts (the Dispatcher's
// registered implementation). Copy the runs/matrix-fanout.ts file verbatim
// into your own repo when forking this recipe — the indirection here keeps
// the recipe page in sync with the registered run without duplicating code.
//
// Spec: specs/02-runs.md § 2. DSL: specs/03-dsl.md.

export { matrixFanout } from "@flare-dispatch/runs/matrix-fanout";
