// FlareDispatch Dispatcher — `GET /v1/artifacts/:execution/:name`.
//
// Serves a per-execution artifact (V0: the `offload-test` step log) so the
// check-run summary's "view logs" / "Full report" links resolve. The artifact
// lives in R2 at `artifacts/<execution>/<name>` — exactly the key
// `R2ArtifactLive.upload` (packages/runtime-cf) writes; this route is the read
// side of that contract.
//
// --- Design decision: STREAM the R2 body, do NOT 302 to a presigned URL -----
//
// specs/pm/plan.md § 1 sketches "302-redirect to a short-lived R2 signed URL",
// but a *true* R2 presigned URL is an S3-API signature requiring an R2 S3
// access-key-id + secret — credentials that are NOT in the V0 secret set
// (specs/05-byoc.md § Secrets lists only `HMAC_SECRET`, `GITHUB_APP_ID`,
// `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`). PR5's mandate (plan § 6,
// "Artifact endpoint scope") is only that the endpoint EXISTS so the link
// resolves.
//
// Two correct options were available:
//   (a) stream the R2 object body straight through this Worker, or
//   (b) 302 to a Worker-self-signed expiring URL that the same Worker verifies
//       on a follow-up GET.
//
// This route implements (a). Rationale: (a) is one R2 `get` + one `Response`;
// (b) adds a second round-trip, an HMAC sign/verify of a query param, an
// expiry clock, and a second code path — all to reach the same bytes through
// the same Worker, since without S3 credentials the "signed URL" can only
// point back at this Worker anyway. Streaming is the strictly simpler correct
// option and the link resolves in one hop. When real R2 S3 credentials enter
// the secret set (V1+), this route can switch to issuing a genuine presigned
// URL + 302 with no change to its callers — the `/v1/artifacts/...` path is
// stable.
//
// The R2 `get` returns the body as a `ReadableStream`, so large artifacts are
// streamed, never buffered. `content-type` is taken from the stored object's
// `httpMetadata` (set at upload time), defaulting to `application/octet-stream`.
//
// Spec: specs/pm/plan.md § PR5 + § 6, specs/03-dsl.md § artifact,
//       specs/05-byoc.md § R2 layout.

import type { Env } from "../env";

/** R2 key for a per-execution artifact — matches `R2ArtifactLive.upload`. */
const artifactKey = (execution: string, name: string): string =>
  `artifacts/${execution}/${name}`;

/** JSON error helper. */
const jsonError = (
  error: string,
  message: string,
  status: number,
): Response =>
  new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Handle `GET /v1/artifacts/:execution/:name` — stream the stored R2 object.
 *
 * @param env        binding env (`RUNS_STORAGE`).
 * @param execution  the execution ULID path segment.
 * @param name       the artifact name path segment.
 * @returns `200` streaming the body, or `404` if no such object.
 */
export const handleArtifact = async (
  env: Env,
  execution: string,
  name: string,
): Promise<Response> => {
  const key = artifactKey(execution, name);
  const object = await env.RUNS_STORAGE.get(key);

  if (object === null) {
    return jsonError(
      "artifact_not_found",
      `no artifact at "${key}"`,
      404,
    );
  }

  // R2 writes the object's stored metadata onto a `Headers` for us; layer the
  // content-type on top (defaulting when the upload didn't set one).
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set(
    "content-type",
    object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  headers.set("etag", object.httpEtag);
  // Logs are immutable per execution+name — safe to cache hard.
  headers.set("cache-control", "private, max-age=31536000, immutable");

  return new Response(object.body, { status: 200, headers });
};
