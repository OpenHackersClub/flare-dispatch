// @flare-dispatch/github-app — check-runs create / update.
//
// The GitHub half of FlareDispatch's `finalize` boundary: post the run's
// green/red verdict back to the originating commit as a check-run.
//
//   * `createCheckRun` — `POST /repos/{owner}/{repo}/check-runs` with
//     `status: in_progress`; returns the GitHub-assigned check-run id.
//   * `updateCheckRun` — `PATCH /repos/{owner}/{repo}/check-runs/{id}` with
//     `status: completed` + a `conclusion`.
//
// Both are authenticated with an installation access token (see
// installation-token.ts) — never an App JWT, never a PAT.
//
// Spec: specs/04-gha-integration.md § Check-runs callback.

import { GithubApiError } from "./errors";

/** GitHub's API host — overridable for tests / GitHub Enterprise. */
const DEFAULT_API_BASE = "https://api.github.com";

/** A check-run conclusion — the terminal verdict GitHub renders. */
export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out";

/** The output block GitHub renders under the check-run detail page. */
export type CheckRunOutput = {
  readonly title: string;
  readonly summary: string;
};

/** Split an `"owner/repo"` slug; throws on a malformed slug. */
const splitRepo = (repo: string): { owner: string; name: string } => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new GithubApiError(`malformed repo slug "${repo}"`, 0, "");
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

/** Common request headers for an installation-token-authenticated call. */
const headers = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "flare-dispatch",
});

/** GitHub's check-run response — only the fields we consume. */
type CheckRunResponse = { readonly id: number };

/** Options shared by {@link createCheckRun} / {@link updateCheckRun}. */
type ClientOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** API base override (tests / GHE). Defaults to `https://api.github.com`. */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/** Options for {@link createCheckRun}. */
export type CreateCheckRunOptions = ClientOptions & {
  /** `"owner/repo"`. */
  readonly repo: string;
  /** The head SHA the check-run is anchored to. */
  readonly sha: string;
  /** Check-run name — e.g. `flare-dispatch/offload-test`. */
  readonly name: string;
  /** Optional initial output block. */
  readonly output?: CheckRunOutput;
  /**
   * Optional `details_url` — the "Details" link GitHub renders on the check.
   * FlareDispatch points it at the Cloudflare Workflows instance page so a
   * reviewer jumps straight from the PR check to the execution's step logs.
   */
  readonly detailsUrl?: string;
};

/**
 * Create a check-run in `in_progress` and resolve to its GitHub-assigned id.
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const createCheckRun = async (
  opts: CreateCheckRunOptions,
): Promise<string> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(
    `${apiBase}/repos/${owner}/${repoName}/check-runs`,
    {
      method: "POST",
      headers: headers(opts.token),
      body: JSON.stringify({
        name: opts.name,
        head_sha: opts.sha,
        status: "in_progress",
        started_at: new Date().toISOString(),
        ...(opts.detailsUrl ? { details_url: opts.detailsUrl } : {}),
        ...(opts.output ? { output: opts.output } : {}),
      }),
    },
  );

  if (!res.ok) {
    throw new GithubApiError(
      "check-run create failed",
      res.status,
      await res.text().catch(() => ""),
    );
  }

  const body = (await res.json()) as CheckRunResponse;
  return String(body.id);
};

/** Options for {@link updateCheckRun}. */
export type UpdateCheckRunOptions = ClientOptions & {
  /** `"owner/repo"`. */
  readonly repo: string;
  /** The check-run id returned by {@link createCheckRun}. */
  readonly checkRunId: string;
  /** The terminal verdict. */
  readonly conclusion: CheckConclusion;
  /** Optional output block — the markdown summary GitHub renders. */
  readonly output?: CheckRunOutput;
  /** Optional `details_url` — preserved on completion so the link persists. */
  readonly detailsUrl?: string;
};

/**
 * Complete a check-run: `status: completed` + a `conclusion`.
 *
 * @throws {GithubApiError} when the API returns non-2xx.
 */
export const updateCheckRun = async (
  opts: UpdateCheckRunOptions,
): Promise<void> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(
    `${apiBase}/repos/${owner}/${repoName}/check-runs/${opts.checkRunId}`,
    {
      method: "PATCH",
      headers: headers(opts.token),
      body: JSON.stringify({
        status: "completed",
        conclusion: opts.conclusion,
        completed_at: new Date().toISOString(),
        ...(opts.detailsUrl ? { details_url: opts.detailsUrl } : {}),
        ...(opts.output ? { output: opts.output } : {}),
      }),
    },
  );

  if (!res.ok) {
    throw new GithubApiError(
      "check-run update failed",
      res.status,
      await res.text().catch(() => ""),
    );
  }
};
