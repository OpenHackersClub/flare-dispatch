// FlareDispatch Dispatcher — RunSandbox: the Container-backed Durable Object.
//
// `RunSandbox` is the Durable Object class behind the `RUNS_SANDBOX` container
// binding. PR1 stubbed it as a bare `DurableObject`; PR4 makes it what the
// Containers API actually requires: a subclass of `@cloudflare/sandbox`'s
// `Sandbox` Durable Object, which wraps a container and exposes the typed
// `exec` / `gitCheckout` RPC surface `SandboxCloudflareLive` drives via
// `getSandbox(env.RUNS_SANDBOX, executionId)`.
//
// The subclasses are intentionally empty — they exist only to give each binding
// a repo-owned, named class (wrangler registers the *class name* in the
// `containers` + `durable_objects` config and the migrations). All behaviour is
// inherited from the SDK's `Sandbox`. A future PR can override lifecycle hooks
// (`onStart`, `onError`) here without touching the binding.
//
// `RunSandboxBrowser` is a second, identical class backing the chromium-baked
// `RUNS_SANDBOX_BROWSER` binding. The Container binding (not the class body) is
// what differs — both are built from infra/Dockerfile.sandbox, the browser one
// with `WITH_BROWSER=true`. Cloudflare requires a DISTINCT DO class per Container
// image, so the routing split (workflow.ts) needs this second class even though
// its code is identical.
//
// Spec: specs/01-architecture.md § Sandbox, specs/pm/plan.md § PR4 + § 6.

import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env";

/**
 * Idle window before a finished container is put to sleep.
 *
 * The SDK default is 10 minutes — and the Container DO bills wall-clock
 * *duration* (DO + container vCPU/memory) the whole time, so every execution
 * paid a 10-minute idle tail after its last command. Across a CI-shaped
 * workload (hundreds of short runs a day) that tail was ~45% of total spend.
 *
 * 2 minutes is safe: `isActivityExpired()` never fires while a request is
 * in-flight (a long quiet `exec` keeps the container awake regardless), and
 * the window restarts when the last request completes — this only trims the
 * *idle* tail. The primary teardown is the explicit `destroy()` at the
 * workflow's finalize boundary (workflow.ts); this is the backstop for paths
 * that die before reaching it (Worker eviction, deploy mid-run).
 */
const SANDBOX_SLEEP_AFTER = "2m";

/** The Durable Object class backing the lean `RUNS_SANDBOX` Container binding. */
export class RunSandbox extends Sandbox<Env> {
  override sleepAfter = SANDBOX_SLEEP_AFTER;
}

/**
 * The Durable Object class backing the chromium-baked `RUNS_SANDBOX_BROWSER`
 * Container binding. Identical to `RunSandbox` — only the bound image differs.
 */
export class RunSandboxBrowser extends Sandbox<Env> {
  override sleepAfter = SANDBOX_SLEEP_AFTER;
}
