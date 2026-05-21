// Recipe: post-deploy smoke test — the `deploy-smoke` Run
//
// Re-exports the canonical run from runs/deploy-smoke.ts (the Dispatcher's
// registered implementation). Copy the runs/deploy-smoke.ts file verbatim
// into your own repo when forking this recipe — the indirection here keeps
// the recipe page in sync with the registered run without duplicating code.
//
// Mode: Webhook mode — fires on `deployment_status.success`, no GHA workflow
//       file. An Action-mode alternative (./ci.yml) dispatches the same run
//       for repos that cannot install the App.
// DSL:  see specs/03-dsl.md.

export { deploySmoke } from "@flare-dispatch/runs/deploy-smoke";
