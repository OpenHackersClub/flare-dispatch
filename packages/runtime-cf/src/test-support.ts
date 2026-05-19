// @flare-dispatch/runtime-cf — integration-test support.
//
// The PR4 integration tests exercise the live D1 / R2 Layers against real
// bindings. `vitest-pool-workers` 0.16 requires Vitest 3, but this monorepo is
// pinned to Vitest 2 — so the tests instead boot a Miniflare instance directly
// (Miniflare is the same local Workers runtime `vitest-pool-workers` uses under
// the hood). `makeTestBindings` spins up Miniflare with D1 + R2 + KV bindings,
// applies infra/d1-schema.sql, and hands back the live `D1Database` /
// `R2Bucket` / `KVNamespace` objects. Plain Node + Vitest, no Workers pool —
// the "or an equivalent" path the PR4 acceptance allows.
//
// Spec: specs/pm/plan.md § PR4 acceptance.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

/** A booted Miniflare instance plus its D1 / R2 / KV bindings. */
export type TestBindings = {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly kv: KVNamespace;
  /** Tear the Miniflare instance down — call in `afterAll`/`afterEach`. */
  readonly dispose: () => Promise<void>;
};

/** The V0 D1 schema, read once — applied to each fresh test database. */
const D1_SCHEMA = readFileSync(
  fileURLToPath(new URL("../../../infra/d1-schema.sql", import.meta.url)),
  "utf8",
);

/**
 * Boot a Miniflare instance with a D1 database + R2 bucket + KV namespace,
 * apply the V0 D1 schema, and return the live bindings. The worker script is a
 * no-op `fetch` handler — the tests drive the bindings directly, never the
 * Worker.
 */
export const makeTestBindings = async (): Promise<TestBindings> => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-05-01",
    d1Databases: { RUNS_METADATA: ":memory:" },
    r2Buckets: { RUNS_STORAGE: "runs-storage" },
    kvNamespaces: { CONFIG_KV: "config-kv" },
  });

  const db = (await mf.getD1Database("RUNS_METADATA")) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket(
    "RUNS_STORAGE",
  )) as unknown as R2Bucket;
  const kv = (await mf.getKVNamespace(
    "CONFIG_KV",
  )) as unknown as KVNamespace;

  // Apply the schema. D1's `exec` runs one statement per line, so the
  // multi-line `CREATE TABLE`s are collapsed to single lines first.
  const statements = D1_SCHEMA.split(";")
    .map((s) =>
      s
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }

  return { db, bucket, kv, dispose: () => mf.dispose() };
};

/** Count rows in a table — the D1-write-rate assertion helper (plan § 6). */
export const countRows = async (
  db: D1Database,
  table: string,
): Promise<number> => {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
};
