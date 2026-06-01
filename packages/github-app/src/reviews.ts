// @flare-dispatch/github-app — PR review (comment) create.
//
// `createPullReview` posts a top-level review on a PR:
//   POST /repos/{owner}/{repo}/pulls/{number}/reviews  { event, body, commit_id }
//
// The `pr-review` run uses `event: "COMMENT"` to leave an always-visible
// comment on every review (success AND failure) without approving / blocking —
// the run's verdict is reported separately via the check-run conclusion.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT. Provider-neutral plain `async`; the Effect
// Layer (`makeGithubLive` in @flare-dispatch/runtime-cf) wraps it.

import { GithubApiError } from "./errors";

/** GitHub's API host — overridable for tests / GitHub Enterprise. */
const DEFAULT_API_BASE = "https://api.github.com";

/** Split an `"owner/repo"` slug; throws on a malformed slug. */
const splitRepo = (repo: string): { owner: string; name: string } => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new GithubApiError(`malformed repo slug "${repo}"`, 0, "");
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

const headers = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "flare-dispatch",
});

/** The review event family GitHub accepts on `POST .../reviews`. */
export type PullReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type CreatePullReviewOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** PR number. */
  readonly pr: number;
  /** Head SHA the review is anchored to (`commit_id`). */
  readonly sha: string;
  /** Markdown review body. */
  readonly body: string;
  /** Review event — defaults to `COMMENT` (visible, non-blocking). */
  readonly event?: PullReviewEvent;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Post a top-level PR review.
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const createPullReview = async (
  opts: CreatePullReviewOptions,
): Promise<void> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(
    `${apiBase}/repos/${owner}/${repoName}/pulls/${opts.pr}/reviews`,
    {
      method: "POST",
      headers: headers(opts.token),
      body: JSON.stringify({
        commit_id: opts.sha,
        body: opts.body,
        event: opts.event ?? "COMMENT",
      }),
    },
  );

  if (!res.ok) {
    throw new GithubApiError(
      "pull review create failed",
      res.status,
      await res.text().catch(() => ""),
    );
  }
};
