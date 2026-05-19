// @flare-dispatch/runtime-cf — CacheR2Live: the live `cache` capability.
//
// Backs `CacheService` with the R2 bucket + the Containers binding. A cache
// entry is a single gzipped tar of the requested paths, stored content-
// addressed at `cache/<key>.tar.gz` — `<key>` is already a lockfile-hash key
// the `installCached` primitive derives, so entries are shared across
// executions and immune to cross-environment poisoning.
//
//   * restoreOr — `bucket.get` the archive; on a hit, stream it into the
//     container and `tar xzf` it in place, then return (no `onMiss` ran). On a
//     miss — or any restore error — run `onMiss`, then best-effort `save`.
//   * save — `tar czf` the paths inside the container, stream the archive out,
//     and `bucket.put` it.
//
// Caching is an optimization, never a correctness primitive: a corrupt or
// unreachable archive degrades to a miss, and a `save` failure inside
// `restoreOr` is swallowed — the `onMiss` work already succeeded.
//
// ============================================================================
// Verification scope — same constraint as sandbox-cf.ts
// ============================================================================
//
// The R2 round-trip (`get` / `put`) is exercised by Miniflare in unit tests,
// but the container side (`tar`, `readFileStream`, `writeFile`) cannot run in
// `vitest-pool-workers` — Miniflare has no container runtime. This Layer's
// container I/O is therefore verified by typecheck + `wrangler deploy
// --dry-run`; the end-to-end cache hit/miss is a `wrangler dev` smoke.
//
// Spec: specs/03-dsl.md § cache, specs/02-runs.md § cache-pnpm, plan § PR8.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import {
  Cache,
  CacheError,
  type CacheService,
} from "@flare-dispatch/core";

/** Content-addressed R2 key for a cache entry. */
const archiveKey = (key: string): string => `cache/${key}.tar.gz`;

/** In-container scratch path the tarball is packed to / extracted from. */
const TARBALL_PATH = "/tmp/fd-cache.tar.gz";

/**
 * Build the live `Cache` Layer bound to an R2 bucket and the Containers
 * binding. Unlike artifact / log keys, cache keys are NOT execution-scoped —
 * the whole point is reuse across executions — so no `executionId` is threaded.
 *
 * @param bucket  the R2 binding (`env.RUNS_STORAGE`).
 * @param ns      the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>.
 */
export const makeCacheR2Live = (
  bucket: R2Bucket,
  ns: DurableObjectNamespace<Sandbox>,
): Layer.Layer<Cache> => {
  /** Pack `paths` (relative to `dir`) into the archive and persist it to R2. */
  const save = (opts: {
    key: string;
    paths: readonly string[];
    container: { readonly id: string };
    dir?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const box = getSandbox(ns, opts.container.id);
        const tar = await box.exec(
          `tar czf ${TARBALL_PATH} ${opts.paths.join(" ")}`,
          { cwd: opts.dir },
        );
        if (tar.exitCode !== 0) {
          throw new Error(`tar czf exited ${tar.exitCode}: ${tar.stderr}`);
        }
        // R2 `put` needs a known length, so the archive is buffered — V1 cache
        // sizes (a node_modules tree) are modest enough to hold in memory.
        const stream = await box.readFileStream(TARBALL_PATH);
        const body = await new Response(stream).arrayBuffer();
        await bucket.put(archiveKey(opts.key), body, {
          httpMetadata: { contentType: "application/gzip" },
        });
      },
      catch: (cause) =>
        new CacheError({ phase: "save", key: opts.key, cause }),
    });

  /** Restore the archive into the container. `true` = hit, `false` = miss. */
  const restore = (opts: {
    key: string;
    container: { readonly id: string };
    dir?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const archive = await bucket.get(archiveKey(opts.key));
        if (archive === null) return false;
        const box = getSandbox(ns, opts.container.id);
        await box.writeFile(TARBALL_PATH, archive.body);
        const untar = await box.exec(`tar xzf ${TARBALL_PATH}`, {
          cwd: opts.dir,
        });
        if (untar.exitCode !== 0) {
          throw new Error(`tar xzf exited ${untar.exitCode}: ${untar.stderr}`);
        }
        return true;
      },
      catch: (cause) =>
        new CacheError({ phase: "restore", key: opts.key, cause }),
    });

  const service: CacheService = {
    restoreOr: <A, E, R>(opts: {
      key: string;
      paths: readonly string[];
      container: { readonly id: string };
      dir?: string;
      onMiss: () => Effect.Effect<A, E, R>;
    }): Effect.Effect<A, E | CacheError, R> =>
      restore(opts).pipe(
        // A corrupt or unreachable archive is a miss, not a failure.
        Effect.orElseSucceed(() => false),
        Effect.flatMap((hit) =>
          hit
            ? // On a hit `onMiss` never ran — there is no `A`. The contract's
              // consumers (`installCached`) discard `restoreOr`'s result; the
              // cast records that `A` is only meaningful on the miss path.
              Effect.succeed(undefined as A)
            : opts.onMiss().pipe(
                Effect.tap(() => Effect.ignore(save(opts))),
              ),
        ),
      ),

    save,
  };

  return Layer.succeed(Cache, service);
};
