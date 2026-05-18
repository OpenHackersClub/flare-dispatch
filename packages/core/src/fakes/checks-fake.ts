// @flare-dispatch/core — Checks fake.
//
// Records every GitHub check-run `create` / `update` call so tests can assert
// "one create with in_progress, one update with conclusion=success". `create`
// returns a deterministic incrementing check-run id.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/04-gha-integration.md.

import { Effect, Layer } from "effect";
import {
  type CheckConclusion,
  Checks,
  type ChecksService,
  type CheckOutput,
} from "../services/checks";

export type CheckCreateCall = {
  readonly checkRunId: string;
  readonly repo: string;
  readonly sha: string;
  readonly name: string;
  readonly output?: CheckOutput;
};

export type CheckUpdateCall = {
  readonly checkRunId: string;
  readonly repo: string;
  readonly conclusion: CheckConclusion;
  readonly output?: CheckOutput;
};

/** Inspectable record of every check-run call. */
export type ChecksFakeState = {
  readonly creates: CheckCreateCall[];
  readonly updates: CheckUpdateCall[];
};

/** Build a Checks fake plus an inspectable handle. */
export const makeChecksFake = (): {
  layer: Layer.Layer<Checks>;
  state: ChecksFakeState;
} => {
  const state: ChecksFakeState = { creates: [], updates: [] };
  let checkRunSeq = 0;

  const service: ChecksService = {
    create: ({ repo, sha, name, output }) =>
      Effect.sync(() => {
        checkRunSeq += 1;
        const checkRunId = `fake-check-${checkRunSeq}`;
        state.creates.push({ checkRunId, repo, sha, name, output });
        return checkRunId;
      }),

    update: ({ repo, checkRunId, conclusion, output }) =>
      Effect.sync(() => {
        state.updates.push({ checkRunId, repo, conclusion, output });
      }),
  };

  return { layer: Layer.succeed(Checks, service), state };
};

/** A ready-to-use Checks fake Layer. */
export const ChecksFake: Layer.Layer<Checks> = makeChecksFake().layer;
