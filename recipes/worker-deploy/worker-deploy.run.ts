// Recipe: continuous deployment on default-branch push — the `worker-deploy` Run
//
// Re-exports the canonical run from runs/worker-deploy.ts (the Dispatcher's
// registered implementation). Copy the runs/worker-deploy.ts file verbatim
// into your own repo when forking this recipe — the indirection here keeps
// the recipe page in sync with the registered run without duplicating code.
//
// Mode: Webhook mode — fires on `check_suite.requested` gated to the repo's
//       default branch (GitHub's per-push signal to checks-writing Apps; no
//       `push` subscription needed). No GHA workflow file. An Action-mode
//       dispatch of the same run works for repos that cannot install the App.
// DSL:  see specs/03-dsl.md.

export { workerDeploy } from "@flare-dispatch/runs/worker-deploy";
