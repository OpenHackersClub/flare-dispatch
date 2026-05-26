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
//   * `runDetached` / `waitForExit` / `waitForPort` — the detached-mode
//     surface `bootApp` rides on — landed in PR9, mapped onto the SDK's
//     `startProcess` / `Process.waitForExit` / `Process.waitForPort`. The V0
//     `Effect.die` stubs are gone: `cdp-acceptance` (V2) needs them.
//
// Container boot itself cannot be exercised in `vitest-pool-workers` (Miniflare
// has no container runtime without Docker), so the integration tests cover
// D1 / R2 / Workflow wiring; this Layer's `exec` / `clone` / detached mapping
// is verified by typecheck + `wrangler deploy --dry-run`. The end-to-end
// container smoke is a `wrangler dev` acceptance.
//
// Spec: specs/01-architecture.md § Sandbox, specs/03-dsl.md § sandbox.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import {
  CheckoutFailed,
  type Container,
  ContainerLaunchFailed,
  type DetachedHandle,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  PortNeverOpened,
  Sandbox as SandboxTag,
  type SandboxService,
} from "@flare-dispatch/core";
import { getInstallationToken } from "@flare-dispatch/github-app";
import type { ChecksGithubConfig } from "./checks-github";
import { authenticateCloneUrl, repoUrl } from "./sandbox-clone-url";

/** Normalise a `command` (string | array) to a single shell string. */
const asCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");


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
 * @param githubAuth   GitHub App credentials + installation id. When present,
 *                     `gitClone` authenticates the GitHub HTTPS clone URL with
 *                     a short-lived installation token so private repositories
 *                     are reachable. When absent, clones are unauthenticated
 *                     — the public-repo path is unchanged.
 */
export const makeSandboxCloudflareLive = (
  ns: DurableObjectNamespace<Sandbox>,
  bucket: R2Bucket,
  executionId: string,
  githubAuth?: ChecksGithubConfig,
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
          // Authenticate the clone URL when GitHub App credentials are wired
          // (private-repo case). The token is short-lived (~1h) and never
          // leaves the Worker — it is embedded in the URL passed to the
          // sandbox's `gitCheckout`, which uses it once for the initial
          // fetch. Public repos and operator-supplied custom URLs skip the
          // rewrite (see `authenticateCloneUrl`).
          let cloneUrl = repoUrl(repo);
          if (githubAuth !== undefined) {
            const token = await getInstallationToken(githubAuth);
            cloneUrl = authenticateCloneUrl(cloneUrl, token);
          }
          await box.gitCheckout(cloneUrl, { targetDir });
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

    // Detached execution (PR9) — `bootApp`'s "start the app, return at once"
    // path. `startProcess` launches a long-running process; the run later
    // recovers it by id via `getProcess` to wait on its port / its exit.
    runDetached: ({ command, cwd, env, timeoutSec }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        try: async () => {
          const proc = await box.startProcess(cmd, {
            cwd,
            env,
            timeout: timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
          return {
            id: proc.id,
            container: { id: executionId },
          } satisfies DetachedHandle;
        },
        // No container image in scope here — the failure is a process-launch
        // failure, the closest tag the `SandboxService` contract offers.
        catch: (cause) => new ContainerLaunchFailed({ image: "", cause }),
      });
    },

    waitForExit: ({ handle }) =>
      Effect.tryPromise({
        try: async (): Promise<ExecResult> => {
          const startedAt = Date.now();
          const proc = await box.getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          const exit = await proc.waitForExit();
          const logs = await proc.getLogs();
          const logPath = nextLogKey();
          await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
          return {
            exitCode: exit.exitCode,
            durationMs: Date.now() - startedAt,
            logPath,
            stdout: logs.stdout,
            stderr: logs.stderr,
          };
        },
        // `waitForExit` only fails its Effect on a timeout / a vanished
        // process — a non-zero exit is a normal `ExecResult` above.
        catch: (cause): ExecTimeout =>
          new ExecTimeout({
            timeoutSec: 0,
            command: `detached:${handle.id} — ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      }),

    waitForPort: ({ handle, port, timeoutSec }) =>
      Effect.tryPromise({
        try: async () => {
          const proc = await box.getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          // TCP mode: the app is "up" once the port accepts connections — it
          // need not yet answer 2xx at `/`.
          await proc.waitForPort(port, {
            mode: "tcp",
            timeout:
              timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
        },
        catch: (): PortNeverOpened =>
          new PortNeverOpened({ port, timeoutSec: timeoutSec ?? 0 }),
      }),
  };

  return Layer.succeed(SandboxTag, service);
};
