// FlareDispatch Dispatcher — RunSandbox: the Container-backed Durable Object.
//
// `RunSandbox` is the Durable Object class behind the `RUNS_SANDBOX` container
// binding. PR1 stubbed it as a bare `DurableObject`; PR4 makes it what the
// Containers API actually requires: a subclass of `@cloudflare/sandbox`'s
// `Sandbox` Durable Object, which wraps a container and exposes the typed
// `exec` / `gitCheckout` RPC surface `SandboxCloudflareLive` drives via
// `getSandbox(env.RUNS_SANDBOX, executionId)`.
//
// The subclass is intentionally empty — it exists only to give the binding a
// repo-owned, named class (wrangler registers the *class name* in the
// `containers` + `durable_objects` config and the `v0` migration). All
// behaviour is inherited from the SDK's `Sandbox`. A future PR can override
// lifecycle hooks (`onStart`, `onError`) here without touching the binding.
//
// Spec: specs/01-architecture.md § Sandbox, specs/pm/plan.md § PR4 + § 6.

import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env";

/** The Durable Object class backing the `RUNS_SANDBOX` Container binding. */
export class RunSandbox extends Sandbox<Env> {}
