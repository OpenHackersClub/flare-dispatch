// @flare-dispatch/runtime-cf — R2ArtifactLive: the live `artifact` capability.
//
// Backs `ArtifactService` with the R2 bucket binding. `artifact.upload({ name,
// path })` takes a *source R2 key* in `path` — `offload-test` passes
// `result.logPath`, the `logs/<execId>/<step>.ndjson` key that
// `SandboxCloudflareLive.exec` already streamed the captured output to. Upload
// copies that object to the stable `artifacts/<execId>/<name>` key and returns
// a `/v1/artifacts/<execId>/<name>` URL.
//
// --- Scope, documented (specs/pm/plan.md § 6 "Artifact endpoint scope") ------
//
// The returned URL is the *stable artifact path*, not yet a signed URL: the
// `GET /v1/artifacts/:execution/:name` Dispatcher route that signs an R2 URL
// and 302-redirects is PR5. A `/v1/artifacts/...`-shaped path is exactly what
// PR4's plan calls for ("a stable `/v1/artifacts/...`-shaped path is fine — the
// signing endpoint itself is PR5"). The check-run summary's "view logs" link
// resolves once PR5 lands the route.
//
// Spec: specs/03-dsl.md § artifact, specs/05-byoc.md § R2 layout, plan § PR4.

import { Effect, Layer } from "effect";
import { Artifact, ArtifactUploadFailed, type ArtifactService } from "@flare-dispatch/core";

/** R2 key prefix for per-execution artifacts. */
const artifactKey = (executionId: string, name: string): string =>
  `artifacts/${executionId}/${name}`;

/** The stable, PR5-signable artifact path embedded in the check-run summary. */
const artifactUrl = (executionId: string, name: string): string =>
  `/v1/artifacts/${encodeURIComponent(executionId)}/${encodeURIComponent(name)}`;

/**
 * Build the live `Artifact` Layer bound to an R2 bucket and an execution id.
 *
 * @param bucket       the R2 binding (`env.RUNS_STORAGE`).
 * @param executionId  the current execution — namespaces the artifact key.
 */
export const makeR2ArtifactLive = (
  bucket: R2Bucket,
  executionId: string,
): Layer.Layer<Artifact> => {
  const service: ArtifactService = {
    upload: ({ name, path, contentType }) =>
      Effect.tryPromise({
        try: async () => {
          const key = artifactKey(executionId, name);
          // `path` is a source R2 key (the exec step's log). Read it and
          // re-write it under the stable artifact key. A missing source is a
          // genuine upload failure — surfaced as `ArtifactUploadFailed` below.
          const source = await bucket.get(path);
          if (source === null) {
            throw new Error(`artifact source object not found at key "${path}"`);
          }
          // Materialise the source bytes — R2 `put` rejects a raw
          // `ReadableStream` of unknown length, and the V0 artifacts (step
          // logs) are small enough to buffer.
          const body = await source.arrayBuffer();
          await bucket.put(key, body, {
            httpMetadata: {
              contentType:
                contentType ?? source.httpMetadata?.contentType ?? "application/octet-stream",
            },
          });
          return artifactUrl(executionId, name);
        },
        catch: (cause) => new ArtifactUploadFailed({ name, cause }),
      }),

    list: ({ executionId: forExecution }) =>
      Effect.promise(async () => {
        const listed = await bucket.list({
          prefix: `artifacts/${forExecution}/`,
        });
        return listed.objects.map((obj) => {
          const name = obj.key.slice(`artifacts/${forExecution}/`.length);
          return {
            name,
            size: obj.size,
            contentType:
              obj.httpMetadata?.contentType ?? "application/octet-stream",
            url: artifactUrl(forExecution, name),
          };
        });
      }),
  };

  return Layer.succeed(Artifact, service);
};
