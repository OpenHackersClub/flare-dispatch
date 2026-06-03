// @flare-dispatch/github-app — draft pull-request create (Git Data API).
//
// `openDraftPullRequest` commits a set of file edits and opens a DRAFT PR — all
// from the Worker via the Git Data API, with NO container `git push`:
//
//   1. resolve the base branch (default branch when unspecified) + its tip;
//   2. create a blob per file, then a tree on top of the base commit's tree;
//   3. create a commit, then create-or-fast-forward `refs/heads/<headBranch>`;
//   4. find an open PR for the head branch, else open a new draft PR.
//
// Idempotent on `headBranch`: a re-run updates the branch (force fast-forward to
// the fresh commit) and reuses the already-open PR. The `spec-drift` /
// `ci-triage` recipes use this to file their proposed fix as a draft PR.
//
// Authenticated with an installation access token — never an App JWT, never a
// PAT. Provider-neutral plain `async`; the Effect Layer (`makeGithubLive`)
// wraps it.

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

/** A file edit — full new content keyed by repo-relative path. */
export type FileEdit = { readonly path: string; readonly content: string };

export type OpenDraftPullRequestOptions = {
  /** The installation access token authenticating the writes. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** Base branch — defaults to the repo's default branch. */
  readonly baseBranch?: string;
  /** Head branch to create/update. */
  readonly headBranch: string;
  /** PR title. */
  readonly title: string;
  /** PR body (markdown). */
  readonly body: string;
  /** Commit message for the edits. */
  readonly commitMessage: string;
  /** Files to write (full new contents). */
  readonly files: readonly FileEdit[];
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

export type OpenDraftPullRequestResult = {
  readonly number: number;
  readonly url: string;
  readonly created: boolean;
};

/** Build a non-blocking-mode git tree entry for a file blob — pure. */
export const treeEntry = (
  path: string,
  sha: string,
): { path: string; mode: "100644"; type: "blob"; sha: string } => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
});

/**
 * Commit the file edits and open (or update) a draft PR.
 *
 * @throws {GithubApiError} when any underlying call returns non-2xx (other than
 * the expected 422 on an already-existing ref, which is handled by updating it).
 */
export const openDraftPullRequest = async (
  opts: OpenDraftPullRequestOptions,
): Promise<OpenDraftPullRequestResult> => {
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const repoUrl = `${apiBase}/repos/${owner}/${name}`;

  const api = async <T>(
    path: string,
    init?: { method?: string; body?: unknown },
    okExtra?: (status: number) => boolean,
  ): Promise<{ status: number; json: T }> => {
    const res = await doFetch(`${repoUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: ghHeaders(opts.token, { json: true }),
      ...(init?.body !== undefined
        ? { body: JSON.stringify(init.body) }
        : {}),
    });
    // A 422 on `POST /git/refs` (ref exists) is expected; the caller passes
    // `okExtra` to tolerate it and fall through to a force-update.
    if (!(okExtra?.(res.status) ?? false)) {
      await assertOk(res, `git data call ${init?.method ?? "GET"} ${path} failed`);
    }
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, json };
  };

  // 1. Base branch + its tip commit.
  const baseBranch =
    opts.baseBranch ??
    (await api<{ default_branch: string }>("")).json.default_branch;

  const baseRef = (
    await api<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    )
  ).json.object.sha;

  const baseTreeSha = (
    await api<{ tree: { sha: string } }>(`/git/commits/${baseRef}`)
  ).json.tree.sha;

  // 2. A blob per file → a tree on top of the base tree.
  const tree = await Promise.all(
    opts.files.map(async (f) => {
      const blob = await api<{ sha: string }>("/git/blobs", {
        method: "POST",
        body: { content: f.content, encoding: "utf-8" },
      });
      return treeEntry(f.path, blob.json.sha);
    }),
  );
  const newTree = (
    await api<{ sha: string }>("/git/trees", {
      method: "POST",
      body: { base_tree: baseTreeSha, tree },
    })
  ).json.sha;

  // 3. Commit, then create-or-fast-forward the head ref.
  const commitSha = (
    await api<{ sha: string }>("/git/commits", {
      method: "POST",
      body: { message: opts.commitMessage, tree: newTree, parents: [baseRef] },
    })
  ).json.sha;

  const created = await api<unknown>(
    "/git/refs",
    {
      method: "POST",
      body: { ref: `refs/heads/${opts.headBranch}`, sha: commitSha },
    },
    // 422 → the ref already exists; fall through to a force-update.
    (status) => status === 422,
  );
  if (created.status === 422) {
    await api("/git/refs/heads/" + encodeURIComponent(opts.headBranch), {
      method: "PATCH",
      body: { sha: commitSha, force: true },
    });
  }

  // 4. Reuse an open PR for this head, else open a new draft.
  const existing = (
    await api<Array<{ number: number; html_url: string }>>(
      `/pulls?head=${owner}:${encodeURIComponent(opts.headBranch)}&state=open`,
    )
  ).json;
  if (Array.isArray(existing) && existing.length > 0) {
    const pr = existing[0]!;
    // Refresh title/body so a re-run keeps the PR current.
    await api(`/pulls/${pr.number}`, {
      method: "PATCH",
      body: { title: opts.title, body: opts.body },
    });
    return { number: pr.number, url: pr.html_url, created: false };
  }

  const opened = (
    await api<{ number: number; html_url: string }>("/pulls", {
      method: "POST",
      body: {
        title: opts.title,
        head: opts.headBranch,
        base: baseBranch,
        body: opts.body,
        draft: true,
      },
    })
  ).json;
  return { number: opened.number, url: opened.html_url, created: true };
};
