// @flare-dispatch/runtime-cf — GithubLive: the live `github` capability (write).
//
// Backs the one *write* on the `Github` Tag — `pullReview` — with the GitHub
// App PR-reviews API, via `@flare-dispatch/github-app`: an App JWT is exchanged
// for a short-lived installation token (cached in Worker memory), and that
// token authenticates `POST /repos/{o}/{r}/pulls/{n}/reviews`.
//
// The *read* surface (`repositories` / `openPullRequests`) is still V3 work —
// this Layer leaves both as the dying stubs from `GithubDeferred`. Only
// `pullReview` is wired, because the `pr-review` run needs an always-visible PR
// comment on every review.
//
// --- Graceful degradation ----------------------------------------------------
//
// A PR comment is *reporting*, never *correctness* — it must not fail an
// otherwise-green run. When App credentials are absent (local dev, no secrets)
// OR a request carries no installation id, `pullReview` is a logged no-op,
// exactly like the no-op `Checks` Layer. With credentials present, a genuine
// API failure is a typed `GitHubApiError` the run's error boundary handles
// (and still posts a fallback comment path where possible).
//
// Spec: specs/04-gha-integration.md § Check-runs callback (symmetric write).

import {
  createPullReview,
  getInstallationToken,
  GithubApiError as GithubAppApiError,
} from "@flare-dispatch/github-app";
import { Effect, Layer } from "effect";
import {
  Github,
  GitHubApiError,
  type GithubService,
} from "@flare-dispatch/core";

/** The GitHub App credentials the live `pullReview` write needs. */
export type GithubLiveConfig = {
  /** `GITHUB_APP_ID`. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM. */
  readonly privateKeyPem: string;
};

/** Map an HTTP status to the typed `GitHubApiError.reason`. */
const reasonFor = (status: number): GitHubApiError["reason"] =>
  status === 401 || status === 403
    ? "unauthorized"
    : status === 429
      ? "rate-limited"
      : status >= 500
        ? "transient"
        : "other";

const logSkip = (repo: string, pr: number, why: string): Effect.Effect<void> =>
  Effect.logInfo(
    `github.pullReview skipped (${why}) — PR comment on ${repo}#${pr} not posted`,
  );

/**
 * Build the live `Github` Layer. When `config` is `undefined` (no App secrets)
 * `pullReview` is a logged no-op for every request; the read surface always
 * dies (V3 work). With credentials, `pullReview` mints an installation token
 * from each request's `installationId` and posts the review.
 */
export const makeGithubLive = (
  config: GithubLiveConfig | undefined,
): Layer.Layer<Github> => {
  const service: GithubService = {
    repositories: () =>
      Effect.die(
        "github.repositories: not implemented in this deploy — V3 capability",
      ),
    openPullRequests: () =>
      Effect.die(
        "github.openPullRequests: not implemented in this deploy — V3 capability",
      ),

    pullReview: ({ repo, pr, sha, body, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) {
          return yield* logSkip(repo, pr, "no GitHub App credentials");
        }
        if (installationId === undefined || installationId <= 0) {
          return yield* logSkip(repo, pr, "no installation id");
        }

        const token = yield* Effect.tryPromise({
          try: () =>
            getInstallationToken({
              appId: config.appId,
              privateKeyPem: config.privateKeyPem,
              installationId,
            }),
          catch: (cause) => toGitHubApiError(cause),
        });

        yield* Effect.tryPromise({
          try: () =>
            createPullReview({ token, repo, pr, sha, body, event: "COMMENT" }),
          catch: (cause) => toGitHubApiError(cause),
        });
      }),
  };

  return Layer.succeed(Github, service);
};

/** Coerce an unknown thrown value into the core `GitHubApiError`. */
const toGitHubApiError = (cause: unknown): GitHubApiError => {
  const status =
    cause instanceof GithubAppApiError ? cause.status : 0;
  return new GitHubApiError({ status, reason: reasonFor(status) });
};
