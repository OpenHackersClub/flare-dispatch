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
  readonly execs: { command: string; cwd?: string }[];
};

const normalizeCommand = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.join(" ");

const fullResult = (partial: Partial<ExecResult> & { exitCode: number }): ExecResult => ({
  exitCode: partial.exitCode,
  durationMs: partial.durationMs ?? 0,
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
  const state: SandboxFakeState = { acquired: [], clones: [], execs: [] };
  let containerSeq = 0;

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
      state.execs.push({ command, cwd: opts.cwd });
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
        state.execs.push({ command, cwd: opts.cwd });
        containerSeq += 1;
        return {
          id: `fake-detached-${containerSeq}`,
          container: { id: `fake-container-${containerSeq}` },
        } satisfies DetachedHandle;
      }),

    waitForExit: () => Effect.succeed(fullResult({ exitCode: 0 })),

    waitForPort: () => Effect.void,
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
