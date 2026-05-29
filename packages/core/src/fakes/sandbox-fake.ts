// @flare-dispatch/core — Sandbox fake.
//
// In-memory stand-in for container execution. Records every `acquire` / `exec`
// / `gitClone` call and returns canned `ExecResult`s. `sandboxFakeProgram`
// matches the pattern sketched in specs/03-dsl.md § Unit-testing runs: a
// command→result map drives `exec` so a run test never boots a real container.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § sandbox.

import { Effect, Layer } from "effect";
import { ExecFailed, ExecTimeout } from "../errors";
import {
  type Container,
  type DetachedHandle,
  type ExecOpts,
  type ExecResult,
  Sandbox,
  type SandboxService,
} from "../services/sandbox";

/** A canned outcome for a matched command. */
export type CannedExec =
  | (Partial<ExecResult> & { readonly exitCode: number })
  | { readonly fail: "ExecFailed"; readonly exitCode?: number; readonly stderrTail?: string }
  | { readonly fail: "ExecTimeout"; readonly timeoutSec?: number };

/** Map of command-substring → canned outcome. */
export type CannedProgram = Record<string, CannedExec>;

/** Inspectable record of every call made to the fake. */
export type SandboxFakeState = {
  readonly acquired: { image?: string }[];
  readonly clones: { repo: string; sha: string }[];
  /** every `exec` / `runDetached` call — `env` lets tests assert injection. */
  readonly execs: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }[];
  /** every `exposePort` call, in order — lets tests assert the port was exposed. */
  readonly exposed: { port: number; name?: string }[];
};

const normalizeCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");

/**
 * Default `durationMs` for a canned `ExecResult` when a program entry does not
 * pin one. Non-zero so a run test can meaningfully assert that the run threads
 * the `exec` step's checkpointed `durationMs` through to its output (the
 * replay-safe source — see runs/offload-test.ts). A `CannedExec` entry can
 * still override it with an explicit `durationMs`.
 */
const DEFAULT_FAKE_DURATION_MS = 1234;

const fullResult = (partial: Partial<ExecResult> & { exitCode: number }): ExecResult => ({
  exitCode: partial.exitCode,
  durationMs: partial.durationMs ?? DEFAULT_FAKE_DURATION_MS,
  logPath: partial.logPath ?? "logs/fake/exec.ndjson",
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
});

/**
 * Build a Sandbox fake from a canned command→result program plus an
 * inspectable state handle. `exec` finds the first program key that is a
 * substring of the command; an unmatched command yields exit 0.
 */
export const makeSandboxFake = (
  program: CannedProgram = {},
): { layer: Layer.Layer<Sandbox>; state: SandboxFakeState } => {
  const state: SandboxFakeState = {
    acquired: [],
    clones: [],
    execs: [],
    exposed: [],
  };
  let containerSeq = 0;
  const detachedCommands = new Map<string, string>();

  const resolve = (command: string): CannedExec | undefined => {
    const key = Object.keys(program).find((k) => command.includes(k));
    return key === undefined ? undefined : program[key];
  };

  const service: SandboxService = {
    acquire: (opts) =>
      Effect.sync(() => {
        state.acquired.push({ image: opts.image });
        containerSeq += 1;
        return { id: `fake-container-${containerSeq}` } satisfies Container;
      }),

    gitClone: ({ repo, sha }) =>
      Effect.sync(() => {
        state.clones.push({ repo, sha });
        return `/workspace/${repo.split("/").pop() ?? "repo"}`;
      }),

    exec: (opts: ExecOpts) => {
      const command = normalizeCommand(opts.command);
      state.execs.push({ command, cwd: opts.cwd, env: opts.env });
      const canned = resolve(command);
      if (canned && "fail" in canned) {
        return canned.fail === "ExecTimeout"
          ? Effect.fail(
              new ExecTimeout({
                timeoutSec: canned.timeoutSec ?? opts.timeoutSec ?? 600,
                command,
              }),
            )
          : Effect.fail(
              new ExecFailed({
                exitCode: canned.exitCode ?? 1,
                stderrTail: canned.stderrTail ?? "",
              }),
            );
      }
      return Effect.succeed(fullResult(canned ?? { exitCode: 0 }));
    },

    runDetached: (opts: ExecOpts) =>
      Effect.sync(() => {
        const command = normalizeCommand(opts.command);
        state.execs.push({ command, cwd: opts.cwd, env: opts.env });
        containerSeq += 1;
        const id = `fake-detached-${containerSeq}`;
        // Remember the command behind this handle so `waitForExit` can resolve
        // the same canned program entry `exec` would.
        detachedCommands.set(id, command);
        return {
          id,
          container: { id: `fake-container-${containerSeq}` },
        } satisfies DetachedHandle;
      }),

    // Resolve the canned program for the detached command (the same entry
    // `exec` uses), so a program can drive a detached run's exit code / timeout.
    // `waitForExit`'s only failure is `ExecTimeout`; a canned `ExecFailed`
    // becomes a non-zero `ExecResult` (the process ran, then exited non-zero).
    waitForExit: ({ handle }) => {
      const command = detachedCommands.get(handle.id) ?? "";
      const canned = resolve(command);
      if (canned && "fail" in canned) {
        return canned.fail === "ExecTimeout"
          ? Effect.fail(
              new ExecTimeout({
                timeoutSec: canned.timeoutSec ?? 600,
                command,
              }),
            )
          : Effect.succeed(fullResult({ exitCode: canned.exitCode ?? 1 }));
      }
      return Effect.succeed(fullResult(canned ?? { exitCode: 0 }));
    },

    waitForPort: () => Effect.void,

    // Deterministic preview URL so a run test can assert the reachable URL is
    // threaded to the suite without booting a real container.
    exposePort: ({ port, name }) =>
      Effect.sync(() => {
        state.exposed.push({ port, name });
        return { url: `https://${port}-fake-sandbox.example.com` };
      }),
  };

  return { layer: Layer.succeed(Sandbox, service), state };
};

/**
 * A canned Sandbox fake Layer driven by a command→result program. The helper
 * sketched in specs/03-dsl.md § Unit-testing runs — `sandboxFakeProgram({ "pnpm
 * test": { exitCode: 1 } })`. The inspectable state is dropped; tests that need
 * it call `makeSandboxFake` directly.
 */
export const sandboxFakeProgram = (
  program: CannedProgram,
): Layer.Layer<Sandbox> => makeSandboxFake(program).layer;

/** A ready-to-use Sandbox fake Layer with an empty program (all execs exit 0). */
export const SandboxFake: Layer.Layer<Sandbox> = makeSandboxFake().layer;
