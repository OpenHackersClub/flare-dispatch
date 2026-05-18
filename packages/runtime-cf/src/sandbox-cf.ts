// @flare-dispatch/runtime-cf — SandboxCloudflareLive: the live `sandbox` capability.
//
// Backs `SandboxService` with the Cloudflare Containers binding, via the
// `@cloudflare/sandbox` SDK. The SDK's `Sandbox` Durable Object wraps a
// container and exposes a typed `exec` / `gitCheckout` surface over RPC;
// `getSandbox(ns, id)` returns the client proxy. `RunSandbox` (apps/dispatcher)
// is a thin `extends Sandbox` so the binding resolves to a class wrangler can
// register as a Container.
//
// ============================================================================
// PR4-RISK — the flagged Containers-API surface (specs/pm/plan.md § 6)
// ============================================================================
//
// The plan flags `SandboxCloudflareLive` as "the most likely spot to discover a
// mismatch between the spec's Sandbox model and the real, evolving Containers
// API." Outcome of building it:
//
//   * `clone` + `exec` — the V0-critical surface — ARE fully implemented
//     against the current `@cloudflare/sandbox` (0.10.x) API. `exec` maps
//     1:1 to `sandbox.exec(command, { cwd, env, timeout })`; `git.clone` maps
//     to `sandbox.gitCheckout(url, { targetDir })` followed by a SHA checkout
//     `exec`. The narrow `SandboxService` Tag (clone, exec) is exactly the
//     small surface the plan's mitigation asked for.
//
//   * `acquire` is a no-op handle — the SDK has no explicit "acquire a
//     container" step: `getSandbox(ns, id)` lazily provisions the container on
//     the first `exec`/`gitCheckout`. The V0 model is one container per
//     execution (`id = executionId`), so `acquire` just returns that handle.
//
//   * `runDetached` / `waitForExit` / `waitForPort` are NOT on the V0 path
//     (no V0 run uses detached mode — `offload-test` is clone→exec→upload).
//     They are left as `TODO(PR4-risk)` `Effect.die` stubs: the SDK *does*
//     expose `startProcess` / `Process.waitForExit` / `exposePort`, but wiring
//     and testing detached execution belongs with the first run that needs it
//     (cdp-acceptance, V2). Implementing them now would be untested surface.
//
// Container boot itself cannot be exercised in `vitest-pool-workers` (Miniflare
// has no container runtime without Docker), so the PR4 integration tests cover
// D1 / R2 / Workflow wiring; this Layer's `exec`/`clone` mapping is verified by
// typecheck + `wrangler deploy --dry-run`. The end-to-end container smoke is
// PR5's `wrangler dev` acceptance.
//
// Spec: specs/01-architecture.md § Sandbox, specs/03-dsl.md § sandbox.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import {
  CheckoutFailed,
  type Container,
  ExecFailed,
  ExecTimeout,
  Sandbox as SandboxTag,
  type SandboxService,
} from "@flare-dispatch/core";

/** Normalise a `command` (string | array) to a single shell string. */
const asCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");

/** Build a clone URL from an `owner/name` slug. */
const repoUrl = (repo: string): string =>
  repo.startsWith("http") ? repo : `https://github.com/${repo}.git`;

/**
 * Build the live `Sandbox` Layer bound to the Containers binding.
 *
 * One container per execution: the sandbox DO id is the `executionId`, so all
 * steps of one run share a filesystem. The R2 bucket is threaded so `exec`
 * streams each command's captured output to `logs/<execId>/<key>.ndjson` — the
 * `logPath` the `artifact.upload` step then promotes to a stable artifact URL.
 *
 * @param ns           the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>.
 * @param bucket       the R2 binding — exec log NDJSON sink.
 * @param executionId  the current execution; the sandbox id + R2 log prefix.
 */
export const makeSandboxCloudflareLive = (
  ns: DurableObjectNamespace<Sandbox>,
  bucket: R2Bucket,
  executionId: string,
): Layer.Layer<SandboxTag> => {
  // The per-execution sandbox client. `getSandbox` is cheap — the container is
  // provisioned lazily on first use — so resolving it once per Layer build is
  // correct (one container per execution).
  const box = getSandbox(ns, executionId);

  // `exec` log keys are unique within a run: the first exec is `exec.ndjson`
  // (the name the plan's acceptance pins), subsequent execs `exec-2.ndjson`, …
  let execSeq = 0;
  const nextLogKey = (): string => {
    execSeq += 1;
    return execSeq === 1
      ? `logs/${executionId}/exec.ndjson`
      : `logs/${executionId}/exec-${execSeq}.ndjson`;
  };

  /** Render captured stdout/stderr as NDJSON and stream it to R2. */
  const writeLog = async (
    key: string,
    command: string,
    stdout: string,
    stderr: string,
  ): Promise<void> => {
    const lines = [
      JSON.stringify({ stream: "meta", command }),
      ...stdout.split("\n").filter(Boolean).map((line) =>
        JSON.stringify({ stream: "stdout", line }),
      ),
      ...stderr.split("\n").filter(Boolean).map((line) =>
        JSON.stringify({ stream: "stderr", line }),
      ),
    ];
    await bucket.put(key, `${lines.join("\n")}\n`, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  };

  const service: SandboxService = {
    // No explicit acquire in the SDK — the container is provisioned lazily.
    // V0 = one container per execution, so the handle is the execution id.
    acquire: () => Effect.succeed({ id: executionId } satisfies Container),

    gitClone: ({ repo, sha }) =>
      Effect.tryPromise({
        try: async () => {
          const targetDir = `/workspace/${repo.split("/").pop() ?? "repo"}`;
          await box.gitCheckout(repoUrl(repo), { targetDir });
          // `gitCheckout` clones a branch tip; pin the exact SHA so the run is
          // reproducible. A bare clone leaves the repo at the default branch.
          const checkout = await box.exec(`git checkout ${sha}`, {
            cwd: targetDir,
          });
          if (checkout.exitCode !== 0) {
            throw new Error(
              `git checkout ${sha} exited ${checkout.exitCode}: ${checkout.stderr}`,
            );
          }
          return targetDir;
        },
        catch: (cause) => new CheckoutFailed({ repo, sha, cause }),
      }),

    exec: ({ command, cwd, env, timeoutSec }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        // `tryPromise` failure path is `ExecFailed | ExecTimeout` — a command
        // that *could not run as a process*. A non-zero exit of a command that
        // *did* run is a normal `ExecResult` (a failing test), returned below.
        try: async () => {
          const result = await box.exec(cmd, {
            cwd,
            env,
            timeout: timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
          const logPath = nextLogKey();
          await writeLog(logPath, cmd, result.stdout, result.stderr);
          // `stdout`/`stderr` here are the inlined tail; the full NDJSON log is
          // the R2 object at `logPath`.
          return {
            exitCode: result.exitCode,
            durationMs: result.duration,
            logPath,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
        catch: (cause): ExecFailed | ExecTimeout => {
          // The SDK throws on timeout; classify by message, fall back to a
          // generic launch failure.
          const message = cause instanceof Error ? cause.message : String(cause);
          if (/timed?\s*out|timeout/i.test(message)) {
            return new ExecTimeout({
              timeoutSec: timeoutSec ?? 0,
              command: cmd,
            });
          }
          return new ExecFailed({ exitCode: -1, stderrTail: message });
        },
      });
    },

    // TODO(PR4-risk): detached execution. The `@cloudflare/sandbox` SDK exposes
    // `startProcess` / `Process` polling / `exposePort`, but no V0 run uses
    // detached mode (`offload-test` is clone→exec→upload). Wiring + testing
    // these belongs with the first detached-mode run (cdp-acceptance, V2).
    runDetached: () =>
      Effect.die(
        "sandbox.runDetached: not implemented in V0 (TODO(PR4-risk) — see sandbox-cf.ts header)",
      ),
    waitForExit: () =>
      Effect.die(
        "sandbox.waitForExit: not implemented in V0 (TODO(PR4-risk) — see sandbox-cf.ts header)",
      ),
    waitForPort: () =>
      Effect.die(
        "sandbox.waitForPort: not implemented in V0 (TODO(PR4-risk) — see sandbox-cf.ts header)",
      ),
  };

  return Layer.succeed(SandboxTag, service);
};
