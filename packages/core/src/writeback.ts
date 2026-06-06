// @flare-dispatch/core — writeback: the run-declared "propose a diff as a PR"
// contract + its pure manifest validation.
//
// A run definition can declare a `writeback` output. The CONTAINER writes a
// changed-files artifact (a manifest + the file blobs) to a conventional
// artifact location; after the run completes successfully, the WORKER — never
// the container — turns that manifest into a commit + PR via the GitHub App's
// Git Data API. Containers stay credential-free: they never hold a git or gh
// token, they only describe the edit they'd like made.
//
// This module holds two things, both pure and runtime-free:
//
//   1. the `WritebackSpec` shape a run declares (`defineRun({ writeback })`) —
//      the capability is declared in the run DEFINITION (Worker-side config),
//      NEVER assembled from untrusted container output. The container can only
//      fill in file contents within the envelope the definition already
//      allowed (branch, base, allowlist, size cap, the `.github/workflows/**`
//      opt-in).
//
//   2. `validateManifest` — given the run's spec and the manifest the container
//      emitted, decide whether the edit is safe to apply: reject path traversal
//      and absolute paths, enforce the spec's `pathAllowlist`, the total size
//      cap, and the `.github/workflows/**` opt-in; surface every rejection as a
//      typed reason. Pure so it is exercised by plain vitest with no R2, no
//      GitHub, no container — the same property `run-admission.ts` keeps.
//
// The runtime side (read the manifest + blobs from R2, mint the installation
// token, drive blob→tree→commit→ref→PR) lives in `@flare-dispatch/runtime-cf`
// and the dispatcher's `RunWorkflow`, which call into the pure validation here.
//
// Spec: specs/02-runs.md § Writeback, specs/03-dsl.md § defineRun.

import { Schema } from "effect";

/**
 * The conventional artifact name a run uploads its writeback payload under. The
 * container writes `artifacts/writeback/manifest.json` + the file blobs beside
 * it; `artifact.upload({ name: WRITEBACK_ARTIFACT, path: "artifacts/writeback",
 * container })` lands them in R2 under `artifacts/<exec>/writeback/…` (the
 * directory-artifact browse expansion), where the Worker reads them back.
 */
export const WRITEBACK_ARTIFACT = "writeback";

/** The manifest filename within the writeback artifact directory. */
export const WRITEBACK_MANIFEST_FILE = "manifest.json";

/**
 * The subdirectory (within the writeback artifact) holding the file blobs, one
 * per non-deleted manifest entry, keyed by the entry's repo-relative `path`.
 * Keeping blobs under `files/` keeps `manifest.json` unambiguous and lets a
 * path like `manifest.json` itself be a legitimate writeback target.
 */
export const WRITEBACK_FILES_DIR = "files";

/** Default cap on the total bytes a single writeback commit may carry. */
export const DEFAULT_WRITEBACK_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Default cap on the number of files a single writeback commit may touch. */
export const DEFAULT_WRITEBACK_MAX_FILES = 200;

/** The blob mode for a tree entry — a normal file or an executable. */
export type WritebackMode = "100644" | "100755";

/**
 * How the head branch is named. A fixed `branch` is a stable "bot branch":
 * re-runs force-update the same ref and update the one open PR (the
 * `refresh-fixtures` / dependency-bump shape — one canonical proposal that
 * stays current). A `{ prefix }` mints a fresh, unique branch per run (the
 * Worker appends the execution id), so each run opens its own PR.
 */
export type WritebackBranch = string | { readonly prefix: string };

/** The PR to open (or update) once the commit lands. `false` ⇒ push the
 * branch only, open no PR. */
export type WritebackPr =
  | {
      readonly title: string;
      readonly body: string;
      /** Open as a draft PR. Default `true` — a proposed diff wants review. */
      readonly draft?: boolean;
    }
  | false;

/**
 * The writeback capability a run DECLARES. Everything here is Worker-side,
 * trusted config fixed at `defineRun` time — the container cannot widen it.
 */
export type WritebackSpec = {
  /** The head branch name (fixed bot branch) or `{ prefix }` (fresh per run). */
  readonly branch: WritebackBranch;
  /** Base branch to branch the commit from + open the PR against. Defaults to
   * the dispatch's ref / the repo's default branch when omitted. */
  readonly baseBranch?: string;
  /** Commit message for the writeback commit. */
  readonly commitMessage: string;
  /** The PR to open/update, or `false` to push the branch only. */
  readonly pr: WritebackPr;
  /**
   * When the head branch already exists / a PR is already open, update it in
   * place (force-update the ref, refresh the PR) rather than failing. Default
   * `true` — writeback is idempotent across retries by design. Set `false` to
   * make a re-run on an existing fixed branch a no-op instead.
   */
  readonly updateExisting?: boolean;
  /**
   * When set, only paths matching one of these globs may be written. A manifest
   * entry whose path matches none is rejected. Globs support a trailing `/**`
   * (any depth beneath a directory) and a single `*` (any run of non-`/`
   * characters within a segment). Omitted ⇒ any non-traversing path is allowed
   * (still subject to the `.github/workflows/**` gate below).
   */
  readonly pathAllowlist?: readonly string[];
  /** Override the total-bytes cap. Defaults to {@link DEFAULT_WRITEBACK_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Override the file-count cap. Defaults to {@link DEFAULT_WRITEBACK_MAX_FILES}. */
  readonly maxFiles?: number;
  /**
   * Allow writing under `.github/workflows/**`. Off by default: a run that can
   * rewrite a repo's CI workflows is a privilege-escalation vector, and the
   * GitHub App needs the `workflows` permission for the commit to even land. Opt
   * in explicitly per run, and grant the App that permission, before a workflow
   * file can be part of a writeback.
   */
  readonly allowWorkflows?: boolean;
};

/** A single manifest entry — what the CONTAINER asks to change. */
export const WritebackEntry = Schema.Struct({
  /** Repo-relative path (POSIX). Must not be absolute or contain `..`. */
  path: Schema.String,
  /** Blob mode — `"100644"` (default) or `"100755"` (executable). */
  mode: Schema.optional(Schema.Literal("100644", "100755")),
  /** Delete this path instead of writing it. No blob is read for a deletion. */
  deleted: Schema.optional(Schema.Boolean),
});
export type WritebackEntry = Schema.Schema.Type<typeof WritebackEntry>;

/** The manifest the container writes to `writeback/manifest.json`. */
export const WritebackManifest = Schema.Struct({
  entries: Schema.Array(WritebackEntry),
});
export type WritebackManifest = Schema.Schema.Type<typeof WritebackManifest>;

/** Decode an unknown JSON value as a manifest — throws on a malformed shape. */
export const decodeManifest = Schema.decodeUnknownSync(WritebackManifest);

/** Why a manifest entry (or the manifest as a whole) was rejected. */
export type WritebackRejection =
  | { readonly kind: "empty-path"; readonly path: string }
  | { readonly kind: "absolute-path"; readonly path: string }
  | { readonly kind: "path-traversal"; readonly path: string }
  | { readonly kind: "dot-segment"; readonly path: string }
  | { readonly kind: "not-allowlisted"; readonly path: string }
  | { readonly kind: "workflows-not-opted-in"; readonly path: string }
  | { readonly kind: "duplicate-path"; readonly path: string }
  | { readonly kind: "too-many-files"; readonly count: number; readonly cap: number }
  | { readonly kind: "too-large"; readonly bytes: number; readonly cap: number };

/** A validated entry, carrying the resolved mode the writeback will commit. */
export type ValidatedEntry = {
  readonly path: string;
  readonly mode: WritebackMode;
  readonly deleted: boolean;
};

/** The result of validating a manifest against a run's writeback spec. */
export type WritebackValidation =
  | { readonly _kind: "ok"; readonly entries: readonly ValidatedEntry[] }
  | { readonly _kind: "empty" }
  | { readonly _kind: "rejected"; readonly reasons: readonly WritebackRejection[] };

/** `.github/workflows/<file>` (any depth beneath) — the gated prefix. */
const WORKFLOWS_PREFIX = ".github/workflows/";

/**
 * Match a repo-relative path against one allowlist glob. Supports a trailing
 * `/**` (any depth beneath the directory) and `*` within a segment (any run of
 * non-`/` characters). Anchored at both ends — a partial match does not pass.
 */
export const matchGlob = (glob: string, path: string): boolean => {
  // Anchor, escape regex metacharacters, then re-expand the two wildcards.
  // Order matters: `**` before `*` so the doublestar isn't eaten as two singles.
  const DOUBLE = " D"; // placeholders so escaping can't touch them
  const SINGLE = " S";
  const escaped = glob
    .replace(/\/\*\*/g, DOUBLE)
    .replace(/\*/g, SINGLE)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(new RegExp(DOUBLE, "g"), "(?:/.*)?")
    .replace(new RegExp(SINGLE, "g"), "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
};

/**
 * Decide whether a manifest is safe to apply, given the run's writeback spec
 * and the per-entry byte sizes (read from R2 by the runtime; deletions and the
 * manifest itself contribute 0). Pure — no I/O.
 *
 *   - an empty / absent manifest ⇒ `{ _kind: "empty" }` (a clean SKIP, never a
 *     failure — most runs produce no diff);
 *   - any rejected entry / cap breach ⇒ `{ _kind: "rejected", reasons }` with
 *     EVERY reason (so an operator sees all problems at once, not one at a time);
 *   - otherwise ⇒ `{ _kind: "ok", entries }` with the resolved modes.
 *
 * @param spec   the run's declared writeback config (trusted).
 * @param manifest the container-emitted manifest (untrusted).
 * @param sizeOf per-entry blob byte count; called only for non-deleted entries.
 */
export const validateManifest = (
  spec: WritebackSpec,
  manifest: WritebackManifest,
  sizeOf: (entry: ValidatedEntry) => number,
): WritebackValidation => {
  if (manifest.entries.length === 0) {
    return { _kind: "empty" };
  }

  const reasons: WritebackRejection[] = [];
  const maxFiles = spec.maxFiles ?? DEFAULT_WRITEBACK_MAX_FILES;
  const maxBytes = spec.maxBytes ?? DEFAULT_WRITEBACK_MAX_BYTES;

  if (manifest.entries.length > maxFiles) {
    reasons.push({
      kind: "too-many-files",
      count: manifest.entries.length,
      cap: maxFiles,
    });
  }

  const seen = new Set<string>();
  const validated: ValidatedEntry[] = [];

  for (const entry of manifest.entries) {
    const path = entry.path;
    if (path.length === 0) {
      reasons.push({ kind: "empty-path", path });
      continue;
    }
    // Reject absolute paths and Windows drive/UNC absoluteness.
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("\\")) {
      reasons.push({ kind: "absolute-path", path });
      continue;
    }
    const segments = path.split("/");
    if (segments.some((s) => s === "..")) {
      reasons.push({ kind: "path-traversal", path });
      continue;
    }
    // `.` / empty segments (`a//b`, `./a`) are normalised-away noise that could
    // hide a target — reject rather than guess intent.
    if (segments.some((s) => s === "" || s === ".")) {
      reasons.push({ kind: "dot-segment", path });
      continue;
    }
    if (seen.has(path)) {
      reasons.push({ kind: "duplicate-path", path });
      continue;
    }
    seen.add(path);

    // `.github/workflows/**` requires the explicit per-run opt-in (and the App's
    // `workflows` permission). Checked BEFORE the allowlist so the message is
    // precise even when an allowlist would also have rejected it.
    if (path.startsWith(WORKFLOWS_PREFIX) && spec.allowWorkflows !== true) {
      reasons.push({ kind: "workflows-not-opted-in", path });
      continue;
    }

    if (
      spec.pathAllowlist !== undefined &&
      spec.pathAllowlist.length > 0 &&
      !spec.pathAllowlist.some((g) => matchGlob(g, path))
    ) {
      reasons.push({ kind: "not-allowlisted", path });
      continue;
    }

    validated.push({
      path,
      mode: entry.mode ?? "100644",
      deleted: entry.deleted === true,
    });
  }

  // Total size cap — only the entries that survived the per-entry checks count
  // (a rejected manifest is never applied, so its bytes are moot).
  const totalBytes = validated.reduce(
    (sum, e) => sum + (e.deleted ? 0 : sizeOf(e)),
    0,
  );
  if (totalBytes > maxBytes) {
    reasons.push({ kind: "too-large", bytes: totalBytes, cap: maxBytes });
  }

  if (reasons.length > 0) {
    return { _kind: "rejected", reasons };
  }
  return { _kind: "ok", entries: validated };
};

/** A one-line, human-readable description of a rejection — for logs + checks. */
export const describeRejection = (r: WritebackRejection): string => {
  switch (r.kind) {
    case "empty-path":
      return "empty path";
    case "absolute-path":
      return `absolute path rejected: ${r.path}`;
    case "path-traversal":
      return `path traversal rejected: ${r.path}`;
    case "dot-segment":
      return `path with empty/"." segment rejected: ${r.path}`;
    case "not-allowlisted":
      return `path not in allowlist: ${r.path}`;
    case "workflows-not-opted-in":
      return `${r.path} is under .github/workflows/ — the run must set writeback.allowWorkflows (and the App needs the workflows permission)`;
    case "duplicate-path":
      return `duplicate path: ${r.path}`;
    case "too-many-files":
      return `too many files: ${r.count} > cap ${r.cap}`;
    case "too-large":
      return `writeback too large: ${r.bytes} bytes > cap ${r.cap}`;
  }
};

/**
 * Resolve the head branch name from the spec + this execution's id. A fixed
 * `branch` is returned as-is (the stable bot branch a re-run force-updates); a
 * `{ prefix }` is suffixed with the execution id so each run gets a fresh,
 * unique branch (`<prefix>-<exec>`).
 */
export const resolveHeadBranch = (
  branch: WritebackBranch,
  executionId: string,
): string =>
  typeof branch === "string" ? branch : `${branch.prefix}-${executionId}`;
