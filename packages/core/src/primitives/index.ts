// @flare-dispatch/core/primitives — public exports.
//
// Primitives are reusable Effect-TS compositions built on the capabilities
// (`sandbox`, `browser`, `cache`, `artifact`, `io`, `config`). Recipes import
// them from here; the layer boundary stays visible at the top of each recipe:
//
//   import { defineRun, step, sandbox } from "@flare-dispatch/core";
//   import { workspace, sharded } from "@flare-dispatch/core/primitives";
//
// See specs/03-dsl.md § Primitives and ./README.md.

export { workspace, type Workspace } from "./workspace";
export { installCached } from "./install-cached";
export { sharded, type Shard } from "./sharded";
export { bootApp } from "./boot-app";
export { probeHttp, type ProbeResult } from "./probe-http";
export { loadSecrets } from "./load-secrets";
export { awsAssumeRole, type AwsCredentials } from "./aws-assume-role";
