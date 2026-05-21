// FlareDispatch Dispatcher — route acceptance tests (PR5).
//
// Drives the `handleRequest` router directly with a hand-built `Request` + a
// fake `Env` (see test-helpers.ts). No `@cloudflare/vitest-pool-workers` — the
// repo is pinned to Vitest 2 and that pool needs Vitest 3. The router is
// imported instead of the default `index.ts` export so the test stays free of
// the `cloudflare:workers` / `@cloudflare/sandbox` runtime imports — `index.ts`
// only wires `handleRequest` into the Worker `fetch` handler.
//
// Covers the specs/04-gha-integration.md § Failure handling contract:
//   invalid HMAC → 401; valid HMAC + bad body → 400 (Schema error inlined);
//   unknown run → 404; valid HMAC + valid body → 202 { executionId }.
// Plus the artifact endpoint (streams the R2 object) and /health.

import { describe, expect, it } from "vitest";
import { handleRequest } from "./router";
import { fingerprint, sign } from "./hmac";
import {
  makeFakeEnv,
  makeFakeKv,
  makeFakeR2,
  makeFakeWorkflow,
} from "./test-helpers";

const HMAC_SECRET = "acceptance-test-secret-please-rotate";

/** A well-formed `offload-test` dispatch body — `04-gha-integration § body`. */
const validBody = {
  run: "offload-test",
  github: {
    repo: "owner/test-repo",
    ref: "refs/heads/main",
    sha: "abc123def456",
    pr_number: 42,
    actor: "octocat",
    installation_id: 99999,
  },
  inputs: {
    repo: "owner/test-repo",
    sha: "abc123def456",
    command: "pnpm test",
  },
  trigger: {},
};

/** Build a POST /v1/dispatch/:run Request, optionally signed. */
const dispatchRequest = async (
  run: string,
  bodyText: string,
  opts: {
    sign?: boolean;
    signWith?: string;
    signature?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Request> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.signature !== undefined) {
    headers["X-FlareDispatch-Signature"] = opts.signature;
  } else if (opts.sign !== false) {
    headers["X-FlareDispatch-Signature"] = await sign(
      opts.signWith ?? HMAC_SECRET,
      new TextEncoder().encode(bodyText),
    );
  }
  if (opts.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }
  return new Request(`https://dispatcher.example/v1/dispatch/${run}`, {
    method: "POST",
    headers,
    body: bodyText,
  });
};

/** Read the `error` field off a JSON error response body. */
const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
};

const fixture = (opts: { withIdempotencyKv?: boolean } = {}) => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const idempotencyKv = opts.withIdempotencyKv ? makeFakeKv() : undefined;
  const env = makeFakeEnv({
    hmacSecret: HMAC_SECRET,
    workflow,
    storage,
    idempotencyKv: idempotencyKv?.binding,
  });
  return { workflow, storage, idempotencyKv, env };
};

describe("GET /health", () => {
  it("returns 200 with status ok and the registered run names", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/health"),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      runs: [
        "cdp-acceptance",
        "deploy-smoke",
        "matrix-fanout",
        "offload-test",
        "playwright-demo",
        "playwright-e2e",
        "product-demo",
      ],
    });
  });

  it("405s a non-GET method", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/health", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/dispatch/:run — HMAC", () => {
  it("invalid HMAC → 401, Workflow never created", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      signWith: "the-wrong-secret",
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("unauthorized");
    expect(workflow.calls).toHaveLength(0);
  });

  it("missing signature header → 401", async () => {
    const { env } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      sign: false,
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
  });

  it("401 body carries `dispatcher_secret_fingerprint` for drift diagnosis (issue #24)", async () => {
    // Locks the diagnostic contract: a 401 always surfaces the dispatcher's
    // own sha256(HMAC_SECRET)[:8] so the caller-side GHA Action can print a
    // matching/non-matching pair. Without this, drift between
    // FLAREDISPATCH_HMAC and HMAC_SECRET is silent and burns operator hours.
    const { env } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      signWith: "the-wrong-secret",
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    const payload = (await res.json()) as {
      error: string;
      message: string;
      dispatcher_secret_fingerprint: string;
    };
    expect(payload.error).toBe("unauthorized");
    expect(payload.dispatcher_secret_fingerprint).toBe(
      await fingerprint(HMAC_SECRET),
    );
    expect(payload.dispatcher_secret_fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("POST /v1/dispatch/:run — validation", () => {
  it("valid HMAC + body failing the run inputs Schema → 400 with the error inlined", async () => {
    const { env, workflow } = fixture();
    // `command` is required by offload-test inputs; omit it.
    const badBody = {
      ...validBody,
      inputs: { repo: "owner/test-repo", sha: "abc123" },
    };
    const bodyText = JSON.stringify(badBody);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; detail: string };
    expect(payload.error).toBe("invalid_inputs");
    // The Schema parse error is inlined and mentions the missing field.
    expect(payload.detail).toContain("command");
    expect(workflow.calls).toHaveLength(0);
  });

  it("valid HMAC + body failing the envelope Schema → 400", async () => {
    const { env } = fixture();
    // `github.installation_id` is required by the envelope; drop it.
    const badEnvelope = {
      run: "offload-test",
      github: { repo: "owner/x", sha: "deadbeef" },
      inputs: validBody.inputs,
    };
    const bodyText = JSON.stringify(badEnvelope);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_body");
  });

  it("valid HMAC + non-JSON body → 400", async () => {
    const { env } = fixture();
    const bodyText = "this is not json";
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_body");
  });

  it("valid HMAC against an unknown run → 404", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify({ ...validBody, run: "no-such-run" });
    const req = await dispatchRequest("no-such-run", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("run_not_found");
    expect(workflow.calls).toHaveLength(0);
  });
});

describe("POST /v1/dispatch/:run — success", () => {
  it("valid HMAC + valid body → 202 { executionId } with semantic id and creates the Workflow", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    // Semantic instanceId per spec 04-gha § Receiver dedup —
    // `{run}:{repo}:{sha[:12]}` (slashes in repo replaced with `_`).
    expect(payload.executionId).toBe(
      "offload-test:owner_test-repo:abc123def456",
    );

    expect(workflow.calls).toHaveLength(1);
    const call = workflow.calls[0]!;
    expect(call.id).toBe(payload.executionId);

    // `params` is exactly the DispatchPayload shape RunWorkflow decodes,
    // with installation_id + pr_number carried in `github` for PR6.
    const params = call.params as {
      executionId: string;
      run: string;
      github: Record<string, unknown>;
      inputs: Record<string, unknown>;
    };
    expect(params.executionId).toBe(payload.executionId);
    expect(params.run).toBe("offload-test");
    expect(params.github).toEqual({
      repo: "owner/test-repo",
      ref: "refs/heads/main",
      sha: "abc123def456",
      installation_id: 99999,
      pr_number: 42,
    });
    expect(params.inputs).toMatchObject({
      repo: "owner/test-repo",
      sha: "abc123def456",
      command: "pnpm test",
    });
  });

  it("defaults github.ref when omitted, omits pr_number when absent", async () => {
    const { env, workflow } = fixture();
    const body = {
      run: "offload-test",
      github: {
        repo: "owner/test-repo",
        sha: "abc123def456",
        installation_id: 12345,
      },
      inputs: validBody.inputs,
    };
    const bodyText = JSON.stringify(body);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    const params = workflow.calls[0]!.params as {
      github: Record<string, unknown>;
    };
    expect(params.github).toEqual({
      repo: "owner/test-repo",
      ref: "refs/heads/main",
      sha: "abc123def456",
      installation_id: 12345,
    });
    expect("pr_number" in params.github).toBe(false);
  });
});

describe("GET /v1/artifacts/:execution/:name", () => {
  it("streams the stored R2 object body with its content-type", async () => {
    const { env, storage } = fixture();
    const execution = "01JABCDEF0123456789ABCDEFG";
    const ndjson = '{"line":1}\n{"line":2}\n';
    storage.put(
      `artifacts/${execution}/step.log`,
      ndjson,
      "application/x-ndjson",
    );

    const res = await handleRequest(
      new Request(
        `https://dispatcher.example/v1/artifacts/${execution}/step.log`,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await res.text()).toBe(ndjson);
  });

  it("404s when the artifact does not exist", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request(
        "https://dispatcher.example/v1/artifacts/01MISSING/step.log",
      ),
      env,
    );
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("artifact_not_found");
  });

  it("405s a non-GET method on the artifact path", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/v1/artifacts/01X/step.log", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/dispatch/:run — dedup", () => {
  it("explicit Idempotency-Key header → executionId equals the header value", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText, {
      idempotencyKey: "caller-supplied-key-2026",
    });
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    expect(payload.executionId).toBe("caller-supplied-key-2026");
    expect(workflow.calls).toHaveLength(1);
    expect(workflow.calls[0]!.id).toBe("caller-supplied-key-2026");
  });

  it("second dispatch with same semantic key collapses — one Workflow.create, same executionId", async () => {
    const { env, workflow, idempotencyKv } = fixture({
      withIdempotencyKv: true,
    });
    expect(idempotencyKv).toBeDefined();

    const bodyText = JSON.stringify(validBody);
    const req1 = await dispatchRequest("offload-test", bodyText);
    const res1 = await handleRequest(req1, env);
    expect(res1.status).toBe(202);
    const id1 = (await res1.json() as { executionId: string }).executionId;

    const req2 = await dispatchRequest("offload-test", bodyText);
    const res2 = await handleRequest(req2, env);
    expect(res2.status).toBe(202);
    const id2 = (await res2.json() as { executionId: string }).executionId;

    expect(id1).toBe(id2);
    // Workflow.create is short-circuited on the second call.
    expect(workflow.calls).toHaveLength(1);
  });

  it("without IDEMPOTENCY_KV bound, semantic id is still used — duplicate Workflow.create is the dedup", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    await handleRequest(await dispatchRequest("offload-test", bodyText), env);
    await handleRequest(await dispatchRequest("offload-test", bodyText), env);
    // Two create calls, both with the same semantic id — CF Workflows dedups
    // at the platform level. (Our fake doesn't simulate that.)
    expect(workflow.calls).toHaveLength(2);
    expect(workflow.calls[0]!.id).toBe(workflow.calls[1]!.id);
  });
});

describe("unmatched routes", () => {
  it("404s an unknown path", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/nope"),
      env,
    );
    expect(res.status).toBe(404);
  });
});
