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
import { Duration, Effect, Layer } from "effect";
import {
  CheckoutFailed,
  type Container,
  ContainerLaunchFailed,
  type DetachedHandle,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  type ExposeResult,
  ExposePortFailed,
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
 * @param previewHostname  the Worker's public domain (e.g.
 *                     `flare-dispatch.<account>.workers.dev`) the SDK uses to
 *                     construct container preview URLs in `exposePort`. A
 *                     deploy-time property; absent, `exposePort` fails with
 *                     `ExposePortFailed` (the SDK cannot build a URL without it),
 *                     so a run that needs a reachable URL fails loudly rather
 *                     than handing the suite an unreachable `localhost`.
 */
export const makeSandboxCloudflareLive = (
  ns: DurableObjectNamespace<Sandbox>,
  bucket: R2Bucket,
  executionId: string,
  githubAuth?: ChecksGithubConfig,
  previewHostname?: string,
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

  /**
   * Best-effort capture of a detached process's logs to R2 on a failure path
   * (a boot that never opened its port, a launch that threw). A detached boot
   * leaves no other diagnostic — without this the `steps` row's `log_uri` is
   * `null` and a failed boot is undebuggable. Returns the R2 `logPath` on
   * success, or `undefined` if logs could not be fetched (e.g. the process had
   * already vanished) — a capture failure must never mask the original error,
   * so every step is swallowed.
   */
  const captureDetachedLog = (
    handleId: string,
  ): Effect.Effect<string | undefined> =>
    Effect.promise(async () => {
      try {
        const proc = await box.getProcess(handleId);
        if (proc === null) return undefined;
        const logs = await proc.getLogs();
        const logPath = nextLogKey();
        await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
        return logPath;
      } catch {
        return undefined;
      }
    });

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

    waitForPort: ({ handle, port, timeoutSec }) => {
      // The SDK's own `timeout` option is passed through, but it is not
      // reliably honored — in practice a hung boot blocks far past the ceiling
      // (a single attempt, not retries). Enforce the ceiling at the Effect
      // layer with `Effect.timeoutFail` so the wait fails fast at `timeoutSec`
      // regardless of SDK behavior.
      const sdkWait = Effect.tryPromise({
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
      });

      const bounded =
        timeoutSec === undefined
          ? sdkWait
          : sdkWait.pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(timeoutSec),
                onTimeout: () =>
                  new PortNeverOpened({ port, timeoutSec }),
              }),
            );

      // On any failure (SDK throw or the Effect-level timeout), best-effort
      // capture the detached process's logs and re-fail with the `logPath`
      // attached — the only diagnostic a failed detached boot leaves behind.
      return bounded.pipe(
        Effect.catchTag("PortNeverOpened", (err) =>
          captureDetachedLog(handle.id).pipe(
            Effect.flatMap((logPath) =>
              Effect.fail(
                new PortNeverOpened({
                  port: err.port,
                  timeoutSec: err.timeoutSec,
                  logPath,
                }),
              ),
            ),
          ),
        ),
      );
    },

    exposePort: ({ port, name }) =>
      previewHostname === undefined
        ? Effect.fail(
            new ExposePortFailed({
              port,
              cause:
                "no preview hostname configured — cannot construct a public URL",
            }),
          )
        : Effect.tryPromise({
            try: async (): Promise<ExposeResult> => {
              // The SDK builds the preview URL from the Worker's domain
              // (`hostname`) + the port; the process bound to the container's
              // `localhost:<port>` becomes reachable at the returned URL.
              const { url } = await box.exposePort(port, {
                hostname: previewHostname,
                name,
              });
              return { url };
            },
            catch: (cause) => new ExposePortFailed({ port, cause }),
          }),
  };

  return Layer.succeed(SandboxTag, service);
};
