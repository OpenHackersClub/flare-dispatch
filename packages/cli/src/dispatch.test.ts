// Tests for the dispatch flow. These exercise the pure pieces (body assembly,
// signing) plus the orchestrator (`runDispatch`) with an injected fetch so we
// can drive 202/401/500 paths without a real network or sleeps.
//
// The HMAC fixture must match `apps/dispatcher/src/hmac.dispatch-action.test.
// ts` — same secret, same body, same hex. If those diverge the raw-bytes
// contract is broken.

import { execFileSync } from "node:child_process";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildBody,
  type DispatchEnv,
  type FetchLike,
  runDispatch,
  secretFingerprint,
  signBytes,
} from "./dispatch.js";

const SECRET = "test-hmac-secret-32-bytes-aaaaaaa";

const baseEnv = (overrides: Partial<DispatchEnv> = {}): DispatchEnv => ({
  INPUT_RUN: "offload-test",
  INPUT_ENDPOINT: "https://dispatcher.example.com",
  INPUT_HMAC_SECRET: SECRET,
  INPUT_INPUTS: JSON.stringify({
    repo: "owner/test-repo",
    sha: "abc123",
    command: "pnpm test",
  }),
  INPUT_INSTALLATION_ID: "12345",
  GITHUB_REPOSITORY: "owner/test-repo",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "abc123",
  // backoff = 1ms in tests so the retry path doesn't sleep for real
  FLARE_RETRY_BACKOFF_MS: "1",
  ...overrides,
});

describe("buildBody", () => {
  it("produces the documented JSON shape from INPUT_/GITHUB_ env vars", () => {
    const body = buildBody(baseEnv());
    expect(body).toEqual({
      run: "offload-test",
      github: {
        repo: "owner/test-repo",
        ref: "refs/heads/main",
        sha: "abc123",
        actor: undefined,
        installation_id: 12345,
      },
      inputs: {
        repo: "owner/test-repo",
        sha: "abc123",
        command: "pnpm test",
      },
      trigger: {
        workflow_run_id: undefined,
        job_id: undefined,
      },
    });
  });

  it("defaults installation_id to 0 and leaves actor undefined when unset", () => {
    const body = buildBody(
      baseEnv({
        INPUT_INSTALLATION_ID: undefined,
        GITHUB_ACTOR: undefined,
      }),
    );
    expect(body.github.installation_id).toBe(0);
    expect(body.github.actor).toBeUndefined();
  });

  it("defaults inputs to {} when INPUT_INPUTS is unset", () => {
    const body = buildBody(baseEnv({ INPUT_INPUTS: undefined }));
    expect(body.inputs).toEqual({});
  });

  it("populates trigger.workflow_run_id/job_id when GITHUB_RUN_ID/JOB are set", () => {
    const body = buildBody(
      baseEnv({ GITHUB_RUN_ID: "987654321", GITHUB_JOB: "build" }),
    );
    expect(body.trigger.workflow_run_id).toBe(987654321);
    expect(body.trigger.job_id).toBe("build");
  });
});

describe("signBytes", () => {
  it("matches the openssl|xxd pipeline from dispatch.sh on a known body", () => {
    // This fixture mirrors apps/dispatcher/src/hmac.dispatch-action.test.ts:
    // same secret, same body — the raw-bytes contract is what the GHA Action
    // and the Worker share.
    const sampleBody = JSON.stringify({
      run: "offload-test",
      github: {
        repo: "owner/test-repo",
        ref: "refs/heads/main",
        sha: "abc123",
        installation_id: 12345,
      },
      inputs: {
        repo: "owner/test-repo",
        sha: "abc123",
        command: "pnpm test",
      },
      trigger: {},
    });

    const digest = execFileSync(
      "openssl",
      ["dgst", "-sha256", "-hmac", SECRET, "-binary"],
      { input: sampleBody },
    );
    const opensslHex = execFileSync("xxd", ["-p", "-c", "256"], {
      input: digest,
    })
      .toString()
      .trim();

    const header = signBytes(SECRET, new TextEncoder().encode(sampleBody));
    expect(header).toBe(`sha256=${opensslHex}`);
  });

  it("is stable across calls (same key + bytes -> same hex)", () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const a = signBytes(SECRET, bytes);
    const b = signBytes(SECRET, bytes);
    expect(a).toBe(b);
    expect(a.startsWith("sha256=")).toBe(true);
  });
});

describe("secretFingerprint", () => {
  it("matches the openssl|xxd|cut pipeline the dispatcher uses for parity", () => {
    // The dispatcher's `fingerprint()` (apps/dispatcher/src/hmac.ts) is
    // `sha256(secret)[:8]` lowercase hex. The dispatcher locks this with a
    // cross-side test against `openssl dgst -sha256 | xxd -p | cut -c1-8`;
    // we replicate the same pipeline here so the two sides cannot drift.
    const digest = execFileSync(
      "openssl",
      ["dgst", "-sha256", "-binary"],
      { input: SECRET },
    );
    const opensslFp = execFileSync("xxd", ["-p", "-c", "256"], {
      input: digest,
    })
      .toString()
      .trim()
      .slice(0, 8);

    expect(secretFingerprint(SECRET)).toBe(opensslFp);
    expect(secretFingerprint(SECRET)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("flips when a trailing newline sneaks into the secret", () => {
    // Issue #24's dominant failure mode — `wrangler secret put` adds a `\n`
    // on one side. The fingerprint MUST change so the operator sees it.
    expect(secretFingerprint(SECRET)).not.toBe(secretFingerprint(`${SECRET}\n`));
  });
});

interface MockCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Build a deterministic mock fetch from a queue of responses. */
const mockFetch = (
  responses: Array<{ status: number; body: string } | Error>,
): { fetch: FetchLike; calls: MockCall[] } => {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: new TextDecoder().decode(init.body),
    });
    const next = responses[i++];
    if (!next) throw new Error("mockFetch: no more responses queued");
    if (next instanceof Error) {
      // Mirror defaultFetch's behavior: a network failure surfaces as
      // status 0 (= dispatch.sh's "000" sentinel), not a thrown promise.
      return { status: 0, text: () => Promise.resolve(next.message) };
    }
    const status = next.status;
    const body = next.body;
    return { status, text: () => Promise.resolve(body) };
  };
  return { fetch: fetchImpl, calls };
};

describe("runDispatch", () => {
  it("HTTP 202 → returns executionId and POSTs the signed body", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: JSON.stringify({ executionId: "01HXYZ" }) },
    ]);
    const env = baseEnv();

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.executionId).toBe("01HXYZ");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://dispatcher.example.com/v1/dispatch/offload-test",
    );
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.headers["X-FlareDispatch-Signature"]).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );

    // Signature must match HMAC over the EXACT bytes POSTed (raw-bytes
    // contract). Recompute and compare.
    const expected = signBytes(
      SECRET,
      new TextEncoder().encode(calls[0]?.body ?? ""),
    );
    expect(calls[0]?.headers["X-FlareDispatch-Signature"]).toBe(expected);
  });

  it("strips a single trailing slash from the endpoint", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: '{"executionId":"01ABC"}' },
    ]);
    const env = baseEnv({ INPUT_ENDPOINT: "https://dispatcher.example.com/" });

    await Effect.runPromise(runDispatch({ env, fetch }));

    expect(calls[0]?.url).toBe(
      "https://dispatcher.example.com/v1/dispatch/offload-test",
    );
  });

  it("HTTP 401 fails immediately with PermanentFailure (no retry)", async () => {
    const { fetch, calls } = mockFetch([
      { status: 401, body: "bad signature" },
      // second response should never be consumed
      { status: 202, body: '{"executionId":"shouldnotreach"}' },
    ]);
    const env = baseEnv();

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      // The failure is the tagged PermanentFailure — assert by Cause shape.
      const pretty = JSON.stringify(failure);
      expect(pretty).toContain("PermanentFailure");
      expect(pretty).toContain("401");
    }
    expect(calls).toHaveLength(1);
  });

  it("HTTP 401 attaches local + dispatcher fingerprints for drift diagnosis", async () => {
    // The Worker returns `dispatcher_secret_fingerprint` in 401 bodies
    // (apps/dispatcher/src/routes/dispatch.ts). The CLI must parse it and
    // attach BOTH it and the local sha256(secret)[:8] fingerprint to the
    // PermanentFailure so the reporter can show them.
    const body = JSON.stringify({
      error: "unauthorized",
      message: "HMAC signature missing or invalid",
      dispatcher_secret_fingerprint: "deadbeef",
    });
    const { fetch } = mockFetch([{ status: 401, body }]);
    const env = baseEnv();

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("PermanentFailure");
      expect(pretty).toContain(secretFingerprint(SECRET));
      expect(pretty).toContain("deadbeef");
    }
  });

  it("HTTP 401 with non-JSON body falls back to '<not provided>'", async () => {
    const { fetch } = mockFetch([{ status: 401, body: "plain text 401" }]);
    const env = baseEnv();

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("PermanentFailure");
      expect(pretty).toContain(secretFingerprint(SECRET));
      expect(pretty).toContain("<not provided>");
    }
  });

  it("HTTP 500 then 202 → retries once and succeeds", async () => {
    const { fetch, calls } = mockFetch([
      { status: 500, body: "boom" },
      { status: 202, body: '{"executionId":"01RETRY"}' },
    ]);
    const env = baseEnv();

    const result = await Effect.runPromise(runDispatch({ env, fetch }));

    expect(result.executionId).toBe("01RETRY");
    expect(calls).toHaveLength(2);
    // Both attempts sign the SAME bytes — that's the load-bearing invariant.
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.headers["X-FlareDispatch-Signature"]).toBe(
      calls[1]?.headers["X-FlareDispatch-Signature"],
    );
  });

  it("HTTP 500 thrice → fails with TransientFailure after 3 attempts", async () => {
    const { fetch, calls } = mockFetch([
      { status: 500, body: "boom1" },
      { status: 502, body: "boom2" },
      { status: 503, body: "boom3" },
    ]);
    const env = baseEnv();

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("TransientFailure");
    }
    expect(calls).toHaveLength(3);
  });

  it("network error (status 000) retries like a transient failure", async () => {
    const { fetch, calls } = mockFetch([
      new Error("ECONNREFUSED"),
      { status: 202, body: '{"executionId":"01NET"}' },
    ]);
    const env = baseEnv();

    const result = await Effect.runPromise(runDispatch({ env, fetch }));

    expect(result.executionId).toBe("01NET");
    expect(calls).toHaveLength(2);
  });

  it("missing INPUT_RUN → MissingInput failure", async () => {
    const env = baseEnv({ INPUT_RUN: undefined });
    const { fetch } = mockFetch([]);

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("MissingInput");
      expect(pretty).toContain("run");
    }
  });

  it("INPUT_MODE='await' → BadMode failure with no network call", async () => {
    // The composite "Validate mode" step is folded into the CLI; the JS
    // Action entry must reject `await` before touching the network.
    const env = baseEnv({ INPUT_MODE: "await" });
    const { fetch, calls } = mockFetch([]);

    const exit = await Effect.runPromiseExit(runDispatch({ env, fetch }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = JSON.stringify(exit.cause);
      expect(pretty).toContain("BadMode");
      expect(pretty).toContain("await");
    }
    // No HTTP attempt should be made.
    expect(calls).toHaveLength(0);
  });

  it("INPUT_MODE='fire-and-forget' is accepted (default behavior)", async () => {
    const { fetch } = mockFetch([
      { status: 202, body: '{"executionId":"01OK"}' },
    ]);
    const env = baseEnv({ INPUT_MODE: "fire-and-forget" });

    const result = await Effect.runPromise(runDispatch({ env, fetch }));
    expect(result.executionId).toBe("01OK");
  });

  it("INPUT_MODE unset is treated as fire-and-forget", async () => {
    const { fetch } = mockFetch([
      { status: 202, body: '{"executionId":"01DEF"}' },
    ]);
    const env = baseEnv({ INPUT_MODE: undefined });

    const result = await Effect.runPromise(runDispatch({ env, fetch }));
    expect(result.executionId).toBe("01DEF");
  });
});
