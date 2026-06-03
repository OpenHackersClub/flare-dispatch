// @flare-dispatch/runtime-cf — CloudflareLive: the live `cloudflare` capability.
//
// Backs the read-only `cloudflare` Tag with the Cloudflare REST API, using a
// scoped `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Today it surfaces
// **Pages deployments** — the signal `ci-triage` scans for failed deploys.
//
// --- Graceful degradation ----------------------------------------------------
//
// When the token / account id are absent (no `CLOUDFLARE_API_TOKEN` secret),
// `makeCFRuntimeLive` selects `CloudflareDeferred` (deferred.ts), a logged
// empty — a triage sweep finds nothing CF-side rather than failing. With creds,
// a genuine API failure is a typed `CloudflareApiError`.
//
// The fetch helpers are plain `async` with a `fetchImpl` seam so the URL +
// normalize logic is unit-testable without the Workers runtime (mirrors
// `@flare-dispatch/github-app`).
//
// Spec: specs/03-dsl.md § Capabilities; CLAUDE.md § Prefer wrangler (reads only).

import { Effect, Layer } from "effect";
import {
  Cloudflare,
  CloudflareApiError,
  type CloudflareService,
  type DeploymentRef,
} from "@flare-dispatch/core";

/** The credentials the live `cloudflare` reads need. */
export type CloudflareLiveConfig = {
  /** `CLOUDFLARE_API_TOKEN` — a scoped token (Pages:Read is enough). */
  readonly apiToken: string;
  /** `CLOUDFLARE_ACCOUNT_ID` — the 32-hex account id. */
  readonly accountId: string;
  /** API base override (tests). Defaults to the public API. */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

/** Map an HTTP status to the typed `CloudflareApiError.reason` — pure. */
export const cfReason = (status: number): CloudflareApiError["reason"] =>
  status === 401 || status === 403
    ? "unauthorized"
    : status === 429
      ? "rate-limited"
      : status >= 500
        ? "transient"
        : "other";

/** The Pages-deployments list URL for a project — pure, for unit testing. */
export const pagesDeploymentsUrl = (
  accountId: string,
  project: string,
  apiBase: string = DEFAULT_API_BASE,
): string =>
  `${apiBase}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments`;

/** The Pages-projects list URL — pure. */
export const pagesProjectsUrl = (
  accountId: string,
  apiBase: string = DEFAULT_API_BASE,
): string => `${apiBase}/accounts/${accountId}/pages/projects`;

/** The subset of a CF Pages deployment we consume. */
type RawDeployment = {
  readonly id: string;
  readonly environment?: string | null;
  readonly url?: string | null;
  readonly created_on?: string | null;
  readonly latest_stage?: { readonly status?: string | null } | null;
  readonly deployment_trigger?: {
    readonly metadata?: { readonly branch?: string | null } | null;
  } | null;
};

/** Normalize one raw CF Pages deployment into a {@link DeploymentRef} — pure. */
export const normalizeDeployment = (
  project: string,
  raw: RawDeployment,
): DeploymentRef => {
  const createdMs = raw.created_on ? Date.parse(raw.created_on) : Number.NaN;
  return {
    project,
    id: raw.id,
    environment: raw.environment ?? "",
    status: raw.latest_stage?.status ?? "",
    url: raw.url ?? "",
    branch: raw.deployment_trigger?.metadata?.branch ?? "",
    createdAt: Number.isNaN(createdMs) ? 0 : createdMs,
  };
};

const headers = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "flare-dispatch",
});

/** Build the live `Cloudflare` Layer from a scoped token + account id. */
export const makeCloudflareLive = (
  config: CloudflareLiveConfig,
): Layer.Layer<Cloudflare> => {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const doFetch = config.fetchImpl ?? fetch;

  const getJson = <T>(url: string): Effect.Effect<T, CloudflareApiError> =>
    Effect.tryPromise({
      try: async () => {
        const res = await doFetch(url, {
          method: "GET",
          headers: headers(config.apiToken),
        });
        if (!res.ok) {
          throw new CloudflareApiError({
            status: res.status,
            reason: cfReason(res.status),
          });
        }
        return (await res.json()) as T;
      },
      catch: (cause) =>
        cause instanceof CloudflareApiError
          ? cause
          : new CloudflareApiError({ status: 0, reason: "transient" }),
    });

  const listProjectNames = (): Effect.Effect<
    readonly string[],
    CloudflareApiError
  > =>
    getJson<{ result?: Array<{ name: string }> }>(
      pagesProjectsUrl(config.accountId, apiBase),
    ).pipe(Effect.map((b) => (b.result ?? []).map((p) => p.name)));

  const listDeployments = (
    project: string,
  ): Effect.Effect<readonly DeploymentRef[], CloudflareApiError> =>
    getJson<{ result?: RawDeployment[] }>(
      pagesDeploymentsUrl(config.accountId, project, apiBase),
    ).pipe(
      Effect.map((b) =>
        (b.result ?? []).map((d) => normalizeDeployment(project, d)),
      ),
    );

  const service: CloudflareService = {
    deployments: ({ projects, environment, status, createdWithinHours } = {}) =>
      Effect.gen(function* () {
        const names =
          projects !== undefined && projects.length > 0
            ? projects
            : yield* listProjectNames();
        const cutoff =
          createdWithinHours !== undefined
            ? Date.now() - createdWithinHours * 3_600_000
            : undefined;

        const perProject = yield* Effect.forEach(
          names,
          (project) => listDeployments(project),
          { concurrency: 4 },
        );
        return perProject
          .flat()
          .filter(
            (d) =>
              (environment === undefined || d.environment === environment) &&
              (status === undefined || d.status === status) &&
              (cutoff === undefined || d.createdAt >= cutoff),
          );
      }),
  };

  return Layer.succeed(Cloudflare, service);
};
