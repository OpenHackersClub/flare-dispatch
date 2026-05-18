// FlareDispatch Dispatcher — test fixtures.
//
// PR5 acceptance is exercised by invoking the `fetch` handler with a hand-built
// `Request` against a fake `Env` — NOT `@cloudflare/vitest-pool-workers`, which
// needs Vitest 3 (the repo is pinned to Vitest 2). The fakes here are the
// minimum binding surface the routes touch:
//
//   * RUNS_WORKFLOW.create  — records the `{ id, params }` it was called with.
//   * RUNS_STORAGE          — an in-memory `Map`-backed R2 stand-in (get/put).
//
// Only the methods the routes call are implemented; the rest are cast away.

import type { Env } from "./env";

/** A recorded `RUNS_WORKFLOW.create({ id, params })` call. */
export type WorkflowCreateCall = { readonly id: string; readonly params: unknown };

/** A fake `RUNS_WORKFLOW` that records every `create` call. */
export interface FakeWorkflow {
  readonly binding: Env["RUNS_WORKFLOW"];
  readonly calls: WorkflowCreateCall[];
}

export const makeFakeWorkflow = (): FakeWorkflow => {
  const calls: WorkflowCreateCall[] = [];
  const binding = {
    create: async (options?: { id?: string; params?: unknown }) => {
      calls.push({
        id: options?.id ?? "",
        params: options?.params,
      });
      // Return a minimal WorkflowInstance-shaped object.
      return {
        id: options?.id ?? "",
        status: async () => ({ status: "queued" }),
      };
    },
  } as unknown as Env["RUNS_WORKFLOW"];
  return { binding, calls };
};

/** A stored object in the fake R2 bucket. */
type StoredObject = {
  readonly body: Uint8Array;
  readonly contentType: string;
};

/** A fake `RUNS_STORAGE` (R2) backed by an in-memory Map. */
export interface FakeR2 {
  readonly binding: Env["RUNS_STORAGE"];
  /** Seed an object the way `R2ArtifactLive.upload` would. */
  put(key: string, body: string, contentType?: string): void;
}

export const makeFakeR2 = (): FakeR2 => {
  const store = new Map<string, StoredObject>();
  const encoder = new TextEncoder();

  const binding = {
    get: async (key: string) => {
      const obj = store.get(key);
      if (obj === undefined) return null;
      return {
        key,
        body: new Response(obj.body).body,
        httpEtag: `"fake-etag-${key}"`,
        httpMetadata: { contentType: obj.contentType },
        writeHttpMetadata: (headers: Headers) => {
          headers.set("content-type", obj.contentType);
        },
        arrayBuffer: async () =>
          obj.body.buffer.slice(
            obj.body.byteOffset,
            obj.body.byteOffset + obj.body.byteLength,
          ),
      };
    },
  } as unknown as Env["RUNS_STORAGE"];

  return {
    binding,
    put: (key, body, contentType = "application/octet-stream") => {
      store.set(key, { body: encoder.encode(body), contentType });
    },
  };
};

/** Build a fake `Env` with the given HMAC secret and binding fakes. */
export const makeFakeEnv = (opts: {
  hmacSecret: string;
  workflow: FakeWorkflow;
  storage: FakeR2;
}): Env =>
  ({
    HMAC_SECRET: opts.hmacSecret,
    RUNS_WORKFLOW: opts.workflow.binding,
    RUNS_STORAGE: opts.storage.binding,
    // Not exercised by PR5 routes — cast away.
    RUNS_SANDBOX: {} as Env["RUNS_SANDBOX"],
    RUNS_METADATA: {} as Env["RUNS_METADATA"],
  }) satisfies Env;
