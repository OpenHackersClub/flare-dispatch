import { describe, expect, it, vi } from "vitest";
import { spawnTrailingCoalescer, type CoalesceArgs } from "./coalesce";
import { toInstanceId } from "./instance-id";
import type { Env } from "./env";

/** A fake `RUNS_WORKFLOW` recording `create({id, params})`; optionally throws. */
const makeEnv = (
  onCreate?: (opts: { id?: string; params?: unknown }) => void,
): { env: Env; calls: Array<{ id: string; params: any }> } => {
  const calls: Array<{ id: string; params: any }> = [];
  const binding = {
    create: vi.fn(async (opts?: { id?: string; params?: unknown }) => {
      onCreate?.(opts ?? {});
      calls.push({ id: opts?.id ?? "", params: opts?.params });
      return { id: opts?.id ?? "" };
    }),
  } as unknown as Env["RUNS_WORKFLOW"];
  return { env: { RUNS_WORKFLOW: binding } as unknown as Env, calls };
};

const args: CoalesceArgs = {
  cooledRun: "pr-review",
  coalesceRun: "pr-review-trail",
  priorExecutionId: "pr-review_owner_name_abc123def456",
  retryAfterSec: 1500,
  repo: "owner/name",
  pr: 42,
  ref: "refs/pull/42/head",
  sha: "abc123def456789",
  installationId: 99,
};

describe("spawnTrailingCoalescer", () => {
  it("creates the coalescer with a per-window id + the target's coordinates", async () => {
    const { env, calls } = makeEnv();
    await spawnTrailingCoalescer(env, args);

    expect(calls).toHaveLength(1);
    const { id, params } = calls[0]!;
    // Per-window id: derived from the prior execution id (stable across window).
    expect(id).toBe(toInstanceId(`coalesce:${args.priorExecutionId}`));
    expect(params.run).toBe("pr-review-trail");
    // The coalescer re-dispatches the cooled run against the latest head.
    expect(params.inputs).toMatchObject({
      repo: "owner/name",
      pr: 42,
      sleepSec: 1500,
      targetRun: "pr-review",
      installationId: 99,
    });
    // Github block carries the PR number + installation for the trail's reads.
    expect(params.github).toMatchObject({
      repo: "owner/name",
      pr_number: 42,
      installation_id: 99,
    });
  });

  it("the same window no-ops on the duplicate id (one coalescer per window)", async () => {
    let n = 0;
    const { env, calls } = makeEnv((opts) => {
      n += 1;
      if (n > 1) throw new Error(`instance with id "${opts.id}" already exists`);
    });
    await spawnTrailingCoalescer(env, args);
    await spawnTrailingCoalescer(env, args); // second collapsed push, same window
    // Second create raised already_exists → swallowed; only the first recorded.
    expect(calls).toHaveLength(1);
  });

  it("is best-effort — a non-dedup create failure never throws", async () => {
    const { env } = makeEnv(() => {
      throw new Error("workflows binding unavailable");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(spawnTrailingCoalescer(env, args)).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("omits installationId when absent", async () => {
    const { env, calls } = makeEnv();
    const { installationId: _drop, ...noInstall } = args;
    await spawnTrailingCoalescer(env, noInstall);
    expect(calls[0]!.params.inputs.installationId).toBeUndefined();
    expect(calls[0]!.params.github.installation_id).toBeUndefined();
  });
});
