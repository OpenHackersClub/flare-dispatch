// @flare-dispatch/core — the `github` capability (read-only GitHub access).
//
// The symmetric *read* surface to the `Checks` capability's write side
// (check-runs callback). Scoped to the installations of the FlareDispatch
// GitHub App; runs never see a token — the live Layer mints, caches, and
// scopes them via the same installation-token machinery the Checks Layer
// uses (`@flare-dispatch/github-app`).
//
// Deliberately read-only and narrow: a run produces `findings` and an
// output, and the Dispatcher renders the check-run. The capability exists
// so a run can *discover what to act on* (Schedule-mode enumeration:
// "every open PR across every installed repo"), not so it can act on GitHub
// directly.
//
// Spec: specs/03-dsl.md § github, specs/04-gha-integration.md § Schedule mode.

import { Context, Effect } from "effect";
import type { GitHubApiError } from "../errors";

/** A repository the FlareDispatch App is installed on. */
export type RepoRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly defaultBranch: string;
  readonly installationId: number;
  readonly archived: boolean;
  /** epoch ms — last push to any branch. */
  readonly pushedAt: number;
};

/** An open pull request — the unit of work for `pr-review-sweep`. */
export type PullRequestRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly title: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly author: string;
  readonly installationId: number;
  /** epoch ms. */
  readonly updatedAt: number;
};

/** The service contract a runtime Layer implements. */
export interface GithubService {
  /**
   * Every repo the App is installed on — the enumeration surface for
   * Schedule-mode runs whose unit of work is a repo.
   */
  readonly repositories: (opts?: {
    includeArchived?: boolean;
    pushedWithinDays?: number;
  }) => Effect.Effect<readonly RepoRef[], GitHubApiError>;

  /**
   * Open PRs across every repo the App is installed on. Paginates internally
   * and backs off on secondary rate limits. The primary surface
   * Schedule-mode sweeps enumerate against — a cron tick names no target,
   * so the run must discover them.
   */
  readonly openPullRequests: (opts?: {
    updatedWithinHours?: number;
    includeDrafts?: boolean;
    repos?: readonly string[];
  }) => Effect.Effect<readonly PullRequestRef[], GitHubApiError>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Github extends Context.Tag("@flare-dispatch/core/Github")<
  Github,
  GithubService
>() {}

/**
 * The `github` accessor namespace. Each function reads the Github service
 * from context and delegates — so a run writes `github.openPullRequests(...)`
 * rather than `Effect.flatMap(Github, (g) => g.openPullRequests(...))`.
 */
export const github = {
  repositories: (
    opts: { includeArchived?: boolean; pushedWithinDays?: number } = {},
  ) => Effect.flatMap(Github, (g) => g.repositories(opts)),
  openPullRequests: (
    opts: {
      updatedWithinHours?: number;
      includeDrafts?: boolean;
      repos?: readonly string[];
    } = {},
  ) => Effect.flatMap(Github, (g) => g.openPullRequests(opts)),
} as const;
