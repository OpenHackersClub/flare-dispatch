// @flare-dispatch/core — ChildRuns fake.
//
// In-memory stand-in for the child-Workflow `create` call. Every `spawn`
// appends a record to `state.spawned`; tests assert on it directly — e.g.
// "fanOut spawned 5 children with these inputs" or "a re-spawn of a seen id
// returns created: false". No Workflow binding, no network.
//
// Spec: specs/03-dsl.md § spawnChildRun, specs/pm/plan.md § 3 (fakes/).

import { Effect, Layer } from "effect";
import {
  ChildRuns,
  type ChildRunsService,
  type SpawnChildRunOpts,
} from "../services/child-runs";

/** A recorded spawn — the resolved id, the original input, and the verdict. */
export type SpawnRecord = {
  readonly run: string;
  readonly input: unknown;
  readonly instanceId: string;
  readonly created: boolean;
};

/** Inspectable in-memory spawn log — surfaced for test assertions. */
export type ChildRunsFakeState = {
  readonly spawned: SpawnRecord[];
};

/**
 * Build a ChildRuns fake plus an inspectable handle.
 *
 * `existing` seeds the set of instance ids treated as already-created, so a test
 * can assert the `created: false` dedup path. An explicit `instanceId` in the
 * spawn opts is used verbatim; absent, the fake derives a deterministic id from
 * the run name + spawn ordinal (the live layer hashes the input instead — the
 * fake's id only needs to be stable and unique within a test).
 */
export const makeChildRunsFake = (opts?: {
  existing?: Iterable<string>;
}): { layer: Layer.Layer<ChildRuns>; state: ChildRunsFakeState } => {
  const state: ChildRunsFakeState = { spawned: [] };
  const seen = new Set<string>(opts?.existing ?? []);

  const service: ChildRunsService = {
    spawn: ({ run, input, instanceId }: SpawnChildRunOpts) =>
      Effect.sync(() => {
        const id = instanceId ?? `${run}:${state.spawned.length}`;
        const created = !seen.has(id);
        seen.add(id);
        state.spawned.push({ run, input, instanceId: id, created });
        return { executionId: id, instanceId: id, created };
      }),
  };

  return { layer: Layer.succeed(ChildRuns, service), state };
};

/** A ready-to-use ChildRuns fake Layer (its state is not externally visible). */
export const ChildRunsFake: Layer.Layer<ChildRuns> = makeChildRunsFake().layer;
