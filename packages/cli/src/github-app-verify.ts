// FlareDispatch CLI — `github-app verify` subcommand.
//
// Drift-detect the live GitHub App registration against the committed manifest.
// GitHub has NO API to push permissions/events to an existing App (UI-only), so
// the only safe automation is to READ the live App and fail CI when it diverges
// from `infra/github-app-manifest.json`. This is the detector behind the
// verify-app-registration workflow (push → main); a failing run tells an
// operator to reconcile the App's settings (or the manifest) by hand.
//
// Read-only by design: no App JWT, no secrets, no writes. The live read is the
// unauthenticated public App view (`GET /apps/{slug}`), so this runs on a fork
// or a clean checkout with zero configuration.
//
// Severity (see @flare-dispatch/github-app `diffRegistration`):
//   * permission mismatch / event the manifest needs but the App lacks → FAIL
//   * event subscribed on the App but absent from the manifest          → WARN
//
// Spec: specs/05-byoc.md § GitHub App setup (the manifest is the source of
// truth operators install from).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Import the registration module via its dedicated subpath rather than the
// package barrel: the barrel re-exports `jwt.ts` (App-JWT signing, which needs
// the DOM/Worker `CryptoKey` ambient type) and the CLI's Node tsconfig doesn't
// carry that lib. `./registration` only pulls in `http.ts` + `errors.ts`, both
// Node-clean, so the CLI stays a pure Node program.
import {
  appSettingsUrl,
  diffRegistration,
  fetchPublicAppRegistration,
  hasFailingDrift,
  type AppRegistration,
  type DesiredRegistration,
  type RegistrationDrift,
} from "@flare-dispatch/github-app/registration";
import { Console, Effect, Schema } from "effect";

/**
 * Default manifest location: repo-root `infra/github-app-manifest.json`,
 * resolved relative to THIS module rather than cwd. `pnpm --filter <pkg> cli …`
 * runs with cwd set to the package dir, so a cwd-relative default would resolve
 * to the wrong place; anchoring to the module makes the no-arg invocation work
 * from anywhere (CI step + local). A `--manifest` override is still resolved
 * against cwd (see `runGithubAppVerify`).
 */
export const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL("../../../infra/github-app-manifest.json", import.meta.url),
);

/** The committed manifest path could not be read off disk. */
export class ManifestUnreadable extends Schema.TaggedError<ManifestUnreadable>()(
  "ManifestUnreadable",
  { path: Schema.String, reason: Schema.String },
) {}

/** The manifest parsed but lacks `default_permissions` / `default_events`. */
export class ManifestInvalid extends Schema.TaggedError<ManifestInvalid>()(
  "ManifestInvalid",
  { path: Schema.String, reason: Schema.String },
) {}

/** The public App read (`GET /apps/{slug}`) failed (network / 404 / 5xx). */
export class RegistrationFetchFailed extends Schema.TaggedError<RegistrationFetchFailed>()(
  "RegistrationFetchFailed",
  { slug: Schema.String, reason: Schema.String },
) {}

/** The live App drifted from the manifest in a *failing* way. */
export class RegistrationDrifted extends Schema.TaggedError<RegistrationDrifted>()(
  "RegistrationDrifted",
  { slug: Schema.String, failing: Schema.Number },
) {}

type VerifyError =
  | ManifestUnreadable
  | ManifestInvalid
  | RegistrationFetchFailed
  | RegistrationDrifted;

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Read + validate the manifest's desired registration off disk. */
const readManifest = (
  path: string,
): Effect.Effect<DesiredRegistration, ManifestUnreadable | ManifestInvalid> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ManifestUnreadable({
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ManifestInvalid({
          path,
          reason: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const obj = parsed as {
      default_permissions?: unknown;
      default_events?: unknown;
    };
    if (!isStringRecord(obj.default_permissions)) {
      return yield* Effect.fail(
        new ManifestInvalid({
          path,
          reason: "`default_permissions` missing or not a string→string map",
        }),
      );
    }
    if (!isStringArray(obj.default_events)) {
      return yield* Effect.fail(
        new ManifestInvalid({
          path,
          reason: "`default_events` missing or not an array of strings",
        }),
      );
    }
    return {
      default_permissions: obj.default_permissions,
      default_events: obj.default_events,
    };
  });

const fetchLive = (
  slug: string,
  apiBase: string | undefined,
): Effect.Effect<AppRegistration, RegistrationFetchFailed> =>
  Effect.tryPromise({
    try: () =>
      fetchPublicAppRegistration(slug, apiBase ? { apiBase } : {}),
    catch: (cause) =>
      new RegistrationFetchFailed({
        slug,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/** Whether to emit GitHub Actions annotation lines (`::error::` / `::warning::`). */
const inGithubActions = (): boolean => process.env.GITHUB_ACTIONS === "true";

const renderReport = (
  slug: string,
  drift: RegistrationDrift,
  live: AppRegistration,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const failing = hasFailingDrift(drift);
    const clean =
      !failing && drift.extraEvents.length === 0;

    yield* Console.log(
      `flare-dispatch github-app verify — App "${slug}" vs infra/github-app-manifest.json\n`,
    );

    if (clean) {
      yield* Console.log("✓ registration in sync (permissions + events match)");
      return;
    }

    for (const d of drift.permissionDrift) {
      const line = `permission "${d.permission}": manifest=${d.desired ?? "(absent)"} live=${d.live ?? "(absent)"}`;
      yield* Console.error(`✗ ${line}`);
      if (inGithubActions()) yield* Console.log(`::error::${line}`);
    }
    for (const e of drift.missingEvents) {
      const line = `event "${e}" declared in the manifest but NOT subscribed on the live App`;
      yield* Console.error(`✗ ${line}`);
      if (inGithubActions()) yield* Console.log(`::error::${line}`);
    }
    for (const e of drift.extraEvents) {
      const line = `event "${e}" subscribed on the live App but absent from the manifest (harmless — Dispatcher ignores unconsumed events; trim it in App settings or add a consumer)`;
      yield* Console.log(`! ${line}`);
      if (inGithubActions()) yield* Console.log(`::warning::${line}`);
    }

    yield* Console.log(
      `\nGitHub has no API to push these — reconcile in the App settings UI:\n  ${appSettingsUrl(live, slug)}\n(or update infra/github-app-manifest.json if the live App is correct).`,
    );
  });

export type GithubAppVerifyOptions = {
  /** App slug to read via `GET /apps/{slug}`. */
  readonly slug: string;
  /** Manifest path (resolved against cwd). */
  readonly manifestPath: string;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
};

/**
 * Run the verify flow. Resolves on a clean/warn-only registration; fails with
 * `RegistrationDrifted` (or a read/fetch error) on a failing divergence. The
 * subcommand wrapper maps any failure to a clean non-zero exit.
 */
export const runGithubAppVerify = (
  opts: GithubAppVerifyOptions,
): Effect.Effect<void, VerifyError> =>
  Effect.gen(function* () {
    const manifestPath = resolve(process.cwd(), opts.manifestPath);
    const desired = yield* readManifest(manifestPath);
    const live = yield* fetchLive(opts.slug, opts.apiBase);
    const drift = diffRegistration(desired, live);
    yield* renderReport(opts.slug, drift, live);
    if (hasFailingDrift(drift)) {
      return yield* Effect.fail(
        new RegistrationDrifted({
          slug: opts.slug,
          failing: drift.permissionDrift.length + drift.missingEvents.length,
        }),
      );
    }
  });
