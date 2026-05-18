// @flare-dispatch/core/testing — the in-memory test runtime.
//
// `CFRuntimeTest` is the full `RunContext` wired to in-memory fakes: a run
// Effect executes against it in plain `vitest` with no CF, Docker, or network.
//
// specs/03-dsl.md § Unit-testing runs sketches `CFRuntimeTest` and
// `sandboxFakeProgram` as living in a separate `@flare-dispatch/runtime-test`
// package. V0 consolidates them here, behind the `@flare-dispatch/core/testing`
// sub-path — one fewer package to publish/pin while the surface is small. If
// the test runtime grows its own dependencies it can be split out later; the
// import path (`@flare-dispatch/core/testing`) is the seam that makes that
// move mechanical.
//
// Spec: specs/pm/plan.md § PR2, specs/03-dsl.md § Layers + § Unit-testing runs.

import { Layer } from "effect";
import {
  ArtifactFake,
  type ArtifactFakeState,
  makeArtifactFake,
} from "./fakes/artifact-fake";
import {
  ChecksFake,
  type ChecksFakeState,
  makeChecksFake,
} from "./fakes/checks-fake";
import {
  ExecutionsFake,
  type ExecutionsFakeState,
  makeExecutionsFake,
} from "./fakes/executions-fake";
import { IOFake, type IOFakeState, makeIOFake } from "./fakes/io-fake";
import { BrowserFake, CacheFake, ConfigFake } from "./fakes/misc-fakes";
import {
  makeSandboxFake,
  SandboxFake,
  type SandboxFakeState,
  sandboxFakeProgram,
} from "./fakes/sandbox-fake";
import {
  DEFAULT_TEST_EXECUTION_ID,
  makeStepRunnerInline,
  StepRunnerInline,
} from "./fakes/step-runner-inline";
import type { RunContext } from "./context";

// --- Re-export the fakes + their builders ------------------------------------
export {
  ArtifactFake,
  makeArtifactFake,
  type ArtifactFakeState,
} from "./fakes/artifact-fake";
export {
  ChecksFake,
  makeChecksFake,
  type ChecksFakeState,
  type CheckCreateCall,
  type CheckUpdateCall,
} from "./fakes/checks-fake";
export {
  ExecutionsFake,
  makeExecutionsFake,
  type ExecutionsFakeState,
} from "./fakes/executions-fake";
export {
  IOFake,
  makeIOFake,
  type IOFakeState,
  type IOFakeOptions,
  type LogEntry,
} from "./fakes/io-fake";
export { BrowserFake, CacheFake, ConfigFake } from "./fakes/misc-fakes";
export {
  SandboxFake,
  makeSandboxFake,
  sandboxFakeProgram,
  type SandboxFakeState,
  type CannedExec,
  type CannedProgram,
} from "./fakes/sandbox-fake";
export {
  StepRunnerInline,
  makeStepRunnerInline,
  DEFAULT_TEST_EXECUTION_ID,
} from "./fakes/step-runner-inline";

/**
 * The complete test runtime: every capability service backed by an in-memory
 * fake, the step boundary backed by `StepRunnerInline`. Provide this to a run
 * Effect and it executes fully in-process.
 *
 * The fakes here are the *default* (no-arg) builds — their internal state is
 * not externally visible. A test that needs to assert on fake state composes
 * its own runtime from `makeCFRuntimeTest`.
 */
export const CFRuntimeTest: Layer.Layer<RunContext> = Layer.mergeAll(
  SandboxFake,
  BrowserFake,
  CacheFake,
  ArtifactFake,
  IOFake,
  ConfigFake,
  ChecksFake,
  ExecutionsFake,
  // StepRunnerInline needs Executions + IO — supply them from the merge above.
  Layer.provide(StepRunnerInline, Layer.merge(ExecutionsFake, IOFake)),
);

/** Inspectable handles to every fake in a `makeCFRuntimeTest` runtime. */
export type CFRuntimeTestHandles = {
  readonly sandbox: SandboxFakeState;
  readonly artifact: ArtifactFakeState;
  readonly io: IOFakeState;
  readonly checks: ChecksFakeState;
  readonly executions: ExecutionsFakeState;
};

export type CFRuntimeTestOptions = {
  /** canned command→result program for the sandbox fake. */
  readonly sandboxProgram?: Parameters<typeof makeSandboxFake>[0];
  /** the execution id `StepRunnerInline` records steps under. */
  readonly executionId?: string;
  /** IO fake clock options. */
  readonly io?: Parameters<typeof makeIOFake>[0];
};

/**
 * Build a test runtime *plus* inspectable handles to every fake — the entry
 * point for tests that assert "the fake ExecutionsService recorded N steps" or
 * "the sandbox saw command X". `CFRuntimeTest` is the no-assertion shortcut.
 */
export const makeCFRuntimeTest = (
  opts: CFRuntimeTestOptions = {},
): { layer: Layer.Layer<RunContext>; handles: CFRuntimeTestHandles } => {
  const sandbox = makeSandboxFake(opts.sandboxProgram);
  const artifact = makeArtifactFake();
  const io = makeIOFake(opts.io);
  const checks = makeChecksFake();
  const executions = makeExecutionsFake();
  const stepRunner = makeStepRunnerInline({ executionId: opts.executionId });

  const layer = Layer.mergeAll(
    sandbox.layer,
    BrowserFake,
    CacheFake,
    artifact.layer,
    io.layer,
    ConfigFake,
    checks.layer,
    executions.layer,
    Layer.provide(stepRunner, Layer.merge(executions.layer, io.layer)),
  );

  return {
    layer,
    handles: {
      sandbox: sandbox.state,
      artifact: artifact.state,
      io: io.state,
      checks: checks.state,
      executions: executions.state,
    },
  };
};
