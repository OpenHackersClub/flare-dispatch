// @flare-dispatch/core — Github fake (read-only GitHub access).
//
// In-memory fake of the `github` capability. Tests pre-populate the state with
// `repositories` / `pullRequests` arrays; the service applies the documented
// filters (archived skip, push age, draft skip, repo allow-list, update age)
// and returns the surviving rows. Call counts are recorded for assertions.
//
// A test that wants `github` to fail with `GitHubApiError` constructs its own
// failing `Github` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import {
  Github,
  type GithubService,
  type PullRequestRef,
  type RepoRef,
} from "../services/github";

export type GithubFakeState = {
  /** Seeded repos — returned by `repositories` (after filtering). */
  repositories: RepoRef[];
  /** Seeded PRs — returned by `openPullRequests` (after filtering). */
  pullRequests: PullRequestRef[];
  /** Every `repositories` call, in order. */
  readonly repositoriesCalls: Array<{
    includeArchived: boolean;
    pushedWithinDays?: number;
  }>;
  /** Every `openPullRequests` call, in order. */
  readonly openPullRequestsCalls: Array<{
    updatedWithinHours?: number;
    includeDrafts: boolean;
    repos?: readonly string[];
  }>;
};

/** Default reference clock — fakes use this when callers don't override. */
const DEFAULT_NOW = 1_700_000_000_000;

export const makeGithubFake = (
  opts: {
    repositories?: readonly RepoRef[];
    pullRequests?: readonly PullRequestRef[];
    /** Clock used to evaluate `pushedWithinDays` / `updatedWithinHours`. */
    now?: number;
  } = {},
): { layer: Layer.Layer<Github>; state: GithubFakeState } => {
  const state: GithubFakeState = {
    repositories: [...(opts.repositories ?? [])],
    pullRequests: [...(opts.pullRequests ?? [])],
    repositoriesCalls: [],
    openPullRequestsCalls: [],
  };
  const now = opts.now ?? DEFAULT_NOW;

  const service: GithubService = {
    repositories: ({ includeArchived = false, pushedWithinDays } = {}) =>
      Effect.sync(() => {
        state.repositoriesCalls.push({ includeArchived, pushedWithinDays });
        return state.repositories.filter((r) => {
          if (!includeArchived && r.archived) return false;
          if (pushedWithinDays !== undefined) {
            const cutoff = now - pushedWithinDays * 86_400_000;
            if (r.pushedAt < cutoff) return false;
          }
          return true;
        });
      }),

    openPullRequests: ({
      updatedWithinHours,
      includeDrafts = false,
      repos,
    } = {}) =>
      Effect.sync(() => {
        state.openPullRequestsCalls.push({
          updatedWithinHours,
          includeDrafts,
          repos,
        });
        const allow = repos === undefined ? undefined : new Set(repos);
        return state.pullRequests.filter((pr) => {
          if (!includeDrafts && pr.draft) return false;
          if (allow !== undefined && !allow.has(pr.repo)) return false;
          if (updatedWithinHours !== undefined) {
            const cutoff = now - updatedWithinHours * 3_600_000;
            if (pr.updatedAt < cutoff) return false;
          }
          return true;
        });
      }),
  };

  return { layer: Layer.succeed(Github, service), state };
};

/** A ready-to-use Github fake Layer — empty repos + PRs. */
export const GithubFake: Layer.Layer<Github> = makeGithubFake().layer;
