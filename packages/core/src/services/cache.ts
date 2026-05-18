// @flare-dispatch/core — the `cache` capability (R2-backed restore/save).
//
// `restoreOr` is the canonical pattern: try to restore a content-addressed
// key; on a miss run `onMiss` (which populates the paths), then save.
// Idempotent across step replay. The `installCached` primitive wraps it.
//
// Spec: specs/03-dsl.md § cache.

import { Context, Effect } from "effect";
import type { CacheError } from "../errors";
import type { Container } from "./sandbox";

export interface CacheService {
  readonly restoreOr: <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    onMiss: () => Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E | CacheError, R>;
  readonly save: (opts: {
    key: string;
    paths: readonly string[];
    container: Container;
  }) => Effect.Effect<void, CacheError>;
}

export class Cache extends Context.Tag("@flare-dispatch/core/Cache")<
  Cache,
  CacheService
>() {}

export const cache = {
  restoreOr: <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    onMiss: () => Effect.Effect<A, E, R>;
  }) => Effect.flatMap(Cache, (c) => c.restoreOr(opts)),
  save: (opts: { key: string; paths: readonly string[]; container: Container }) =>
    Effect.flatMap(Cache, (c) => c.save(opts)),
} as const;
