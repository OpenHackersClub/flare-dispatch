// @flare-dispatch/core — Cloudflare fake (read-only Cloudflare API).
//
// In-memory fake of the `cloudflare` capability. Tests seed `deployments` and
// the service applies the documented filters (projects allow-list, status,
// environment, created-age) and returns the surviving rows. Calls are recorded
// for assertions.
//
// A test that wants `cloudflare` to fail with `CloudflareApiError` constructs
// its own failing `Cloudflare` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import {
  Cloudflare,
  type CloudflareService,
  type DeploymentRef,
} from "../services/cloudflare";

export type CloudflareFakeState = {
  /** Seeded deployments — returned by `deployments` (after filtering). */
  deployments: DeploymentRef[];
  /** Every `deployments` call, in order. */
  readonly deploymentsCalls: Array<{
    projects?: readonly string[];
    environment?: string;
    status?: string;
    createdWithinHours?: number;
  }>;
};

/** Default reference clock — fakes use this when callers don't override. */
const DEFAULT_NOW = 1_700_000_000_000;

export const makeCloudflareFake = (
  opts: {
    deployments?: readonly DeploymentRef[];
    /** Clock used to evaluate `createdWithinHours`. */
    now?: number;
  } = {},
): { layer: Layer.Layer<Cloudflare>; state: CloudflareFakeState } => {
  const state: CloudflareFakeState = {
    deployments: [...(opts.deployments ?? [])],
    deploymentsCalls: [],
  };
  const now = opts.now ?? DEFAULT_NOW;

  const service: CloudflareService = {
    deployments: ({ projects, environment, status, createdWithinHours } = {}) =>
      Effect.sync(() => {
        state.deploymentsCalls.push({
          projects,
          environment,
          status,
          createdWithinHours,
        });
        const allow = projects === undefined ? undefined : new Set(projects);
        return state.deployments.filter((d) => {
          if (allow !== undefined && !allow.has(d.project)) return false;
          if (environment !== undefined && d.environment !== environment)
            return false;
          if (status !== undefined && d.status !== status) return false;
          if (createdWithinHours !== undefined) {
            const cutoff = now - createdWithinHours * 3_600_000;
            if (d.createdAt < cutoff) return false;
          }
          return true;
        });
      }),
  };

  return { layer: Layer.succeed(Cloudflare, service), state };
};

/** A ready-to-use Cloudflare fake Layer — empty deployments. */
export const CloudflareFake: Layer.Layer<Cloudflare> = makeCloudflareFake().layer;
