// @flare-dispatch/core — the `sandbox` capability (container execution).
//
// One Context.Tag service; the `sandbox` namespace below is the accessor
// surface runs and primitives import. Backed by a Layer — real CF Containers
// in prod, local Docker under `wrangler dev`, an in-memory fake in tests.
//
// Spec: specs/03-dsl.md § sandbox.

import { Context, type Duration, Effect } from "effect";
import type {
  CheckoutFailed,
  ContainerLaunchFailed,
  ExecFailed,
  ExecTimeout,
  PortNeverOpened,
} from "../errors";

/** A handle to an acquired container; auto-released at run end. */
export type Container = { readonly id: string };

/** A handle to a process started in detached mode. */
export type DetachedHandle = {
  readonly id: string;
  readonly container: Container;
};

/**
 * The result of a command that ran to completion. A non-zero `exitCode` is a
 * normal result (a failing test), surfaced to the run — not an Effect failure.
 */
export type ExecResult = {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly logPath: string; // R2 key for the captured stdout/stderr
  readonly stdout: string; // last N KB inlined; full log streamed to R2
  readonly stderr: string;
};

export type ExecOpts = {
  readonly cwd?: string;
  readonly command: string | readonly string[];
  readonly env?: Record<string, string>;
  readonly timeoutSec?: number;
  readonly container?: Container;
};

/** The service contract a runtime Layer implements. */
export interface SandboxService {
  readonly acquire: (opts: {
    image?: string;
    memMB?: number;
    vCPU?: number;
  }) => Effect.Effect<Container, ContainerLaunchFailed>;
  readonly gitClone: (opts: {
    repo: string;
    sha: string;
    container?: Container;
  }) => Effect.Effect<string, CheckoutFailed>;
  readonly exec: (
    opts: ExecOpts,
  ) => Effect.Effect<ExecResult, ExecFailed | ExecTimeout>;
  readonly runDetached: (
    opts: ExecOpts,
  ) => Effect.Effect<DetachedHandle, ContainerLaunchFailed>;
  readonly waitForExit: (opts: {
    handle: DetachedHandle;
    pollEvery?: Duration.Duration;
  }) => Effect.Effect<ExecResult, ExecTimeout>;
  readonly waitForPort: (opts: {
    handle: DetachedHandle;
    port: number;
    timeoutSec?: number;
  }) => Effect.Effect<void, PortNeverOpened>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Sandbox extends Context.Tag("@flare-dispatch/core/Sandbox")<
  Sandbox,
  SandboxService
>() {}

/**
 * The `sandbox` accessor namespace. Each function reads the Sandbox service
 * from context and delegates — so a run writes `sandbox.exec(...)` rather than
 * `Effect.flatMap(Sandbox, (s) => s.exec(...))`.
 */
export const sandbox = {
  acquire: (opts: { image?: string; memMB?: number; vCPU?: number } = {}) =>
    Effect.flatMap(Sandbox, (s) => s.acquire(opts)),
  git: {
    clone: (opts: { repo: string; sha: string; container?: Container }) =>
      Effect.flatMap(Sandbox, (s) => s.gitClone(opts)),
  },
  exec: (opts: ExecOpts) => Effect.flatMap(Sandbox, (s) => s.exec(opts)),
  runDetached: (opts: ExecOpts) =>
    Effect.flatMap(Sandbox, (s) => s.runDetached(opts)),
  waitForExit: (opts: { handle: DetachedHandle; pollEvery?: Duration.Duration }) =>
    Effect.flatMap(Sandbox, (s) => s.waitForExit(opts)),
  waitForPort: (opts: {
    handle: DetachedHandle;
    port: number;
    timeoutSec?: number;
  }) => Effect.flatMap(Sandbox, (s) => s.waitForPort(opts)),
} as const;
