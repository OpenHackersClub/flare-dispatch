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
import { sign } from "./hmac";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";
import { handleGithubStart } from "./routes/github-start";
import { handleGithubInstalled } from "./routes/github-installed";
import { signState } from "./github-state";

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
  opts: { sign?: boolean; signWith?: string; signature?: string } = {},
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

const fixture = () => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const env = makeFakeEnv({ hmacSecret: HMAC_SECRET, workflow, storage });
  return { workflow, storage, env };
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
      runs: ["cdp-acceptance", "offload-test", "product-demo"],
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
  it("valid HMAC + valid body → 202 { executionId } and creates the Workflow", async () => {
    const { env, workflow } = fixture();
    const bodyText = JSON.stringify(validBody);
    const req = await dispatchRequest("offload-test", bodyText);
    const res = await handleRequest(req, env);

    expect(res.status).toBe(202);
    const payload = (await res.json()) as { executionId: string };
    expect(typeof payload.executionId).toBe("string");
    // A ULID is 26 Crockford-base32 chars.
    expect(payload.executionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

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

// GitHub App manifest-exchange routes (specs/05-byoc.md § GitHub App setup).
// These tests drive the router with hand-built Requests; the
// /v1/github/installed handler talks to api.github.com, so the per-handler
// tests stub `fetch` via the `opts.fetchImpl` seam. Router-level tests here
// only confirm the routes are wired and basic param handling works.

describe("GET /v1/github/start (router wiring)", () => {
  it("router → handleGithubStart → 200 HTML containing a form to github.com", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/v1/github/start"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('action="https://github.com/settings/apps/new?state=');
    expect(body).toContain('name="manifest"');
  });

  it("405s a non-GET on /v1/github/start", async () => {
    const { env } = fixture();
    const res = await handleRequest(
      new Request("https://dispatcher.example/v1/github/start", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("GET /v1/github/start (handler)", () => {
  it("org=<slug> targets the org-scoped GitHub URL", async () => {
    const { env } = fixture();
    const res = await handleGithubStart(
      new Request(
        "https://dispatcher.example/v1/github/start?org=OpenHackersClub",
      ),
      env,
      { now: 1_700_000_000, nonce: "0123456789abcdef" },
    );
    const body = await res.text();
    expect(body).toContain(
      'action="https://github.com/organizations/OpenHackersClub/settings/apps/new?state=',
    );
  });

  it("rejects an org slug that doesn't match GitHub's slug charset", async () => {
    const { env } = fixture();
    const res = await handleGithubStart(
      new Request(
        "https://dispatcher.example/v1/github/start?org=bad%20slug",
      ),
      env,
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_org");
  });

  it("rewrites the manifest URLs to the inbound request's origin", async () => {
    // The manifest the operator clicks through to GitHub must point hook +
    // redirect at THIS Dispatcher, not the placeholder runs.example.com. The
    // builder learns the base URL from the request, so a Worker accessed via
    // a custom domain ends up with that domain in the manifest automatically.
    const { env } = fixture();
    const res = await handleGithubStart(
      new Request(
        "https://flare-dispatch-v0.acme.workers.dev/v1/github/start",
      ),
      env,
      { now: 1_700_000_000, nonce: "0123456789abcdef" },
    );
    const body = await res.text();
    expect(body).toContain(
      "https://flare-dispatch-v0.acme.workers.dev/v1/webhooks/github",
    );
    expect(body).toContain(
      "https://flare-dispatch-v0.acme.workers.dev/v1/github/installed",
    );
  });
});

describe("GET /v1/github/installed", () => {
  /** Mint a `state` that verifies under the test fixture's HMAC_SECRET. */
  const issueState = (ts: number): Promise<string> =>
    signState(HMAC_SECRET, ts, "0123456789abcdef");

  /** A successful manifest-conversion response from api.github.com. */
  const goodConversion = () => ({
    id: 123456,
    slug: "flaredispatch-ohc",
    name: "FlareDispatch",
    html_url: "https://github.com/apps/flaredispatch-ohc",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...fake...\n-----END RSA PRIVATE KEY-----\n",
    webhook_secret: "dGVzdC13ZWJob29rLXNlY3JldA==",
    owner: { login: "OpenHackersClub" },
  });

  /** Fake `fetch` that returns a 200 JSON body. */
  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("400s when `code` or `state` is missing", async () => {
    const { env } = fixture();
    const res = await handleGithubInstalled(
      new Request("https://dispatcher.example/v1/github/installed?code=abc"),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing");
  });

  it("400s when `state` does not verify", async () => {
    const { env } = fixture();
    const res = await handleGithubInstalled(
      new Request(
        "https://dispatcher.example/v1/github/installed?code=abc&state=bogus",
      ),
      env,
      { now: 1_700_000_000 },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/state did not verify/i);
  });

  it("400s when `state` has expired", async () => {
    const { env } = fixture();
    const ts = 1_700_000_000;
    const state = await issueState(ts);
    // Verify 10 minutes later — past the 5-min TTL.
    const res = await handleGithubInstalled(
      new Request(
        `https://dispatcher.example/v1/github/installed?code=abc&state=${encodeURIComponent(state)}`,
      ),
      env,
      { now: ts + 600 },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/i);
  });

  it("calls GitHub with the documented endpoint + version header", async () => {
    const { env } = fixture();
    const ts = 1_700_000_000;
    const state = await issueState(ts);

    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(goodConversion()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await handleGithubInstalled(
      new Request(
        `https://dispatcher.example/v1/github/installed?code=mfst-code-xyz&state=${encodeURIComponent(state)}`,
      ),
      env,
      { now: ts, fetchImpl: recordingFetch },
    );

    expect(seenUrl).toBe(
      "https://api.github.com/app-manifests/mfst-code-xyz/conversions",
    );
    expect(seenHeaders?.get("x-github-api-version")).toBe("2022-11-28");
    expect(seenHeaders?.get("accept")).toBe("application/vnd.github+json");
  });

  it("renders App ID + webhook secret + PEM + install link on success", async () => {
    const { env } = fixture();
    const ts = 1_700_000_000;
    const state = await issueState(ts);
    const creds = goodConversion();

    const res = await handleGithubInstalled(
      new Request(
        `https://dispatcher.example/v1/github/installed?code=mfst-code-xyz&state=${encodeURIComponent(state)}`,
      ),
      env,
      { now: ts, fetchImpl: fakeFetch(creds) },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("✓ App created");
    expect(body).toContain(String(creds.id));
    expect(body).toContain(creds.webhook_secret);
    expect(body).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(body).toContain(`${creds.html_url}/installations/new`);
    expect(body).toContain("wrangler secret put GITHUB_APP_ID");
  });

  it("does NOT cache + does NOT leak referrer on the success page", async () => {
    const { env } = fixture();
    const ts = 1_700_000_000;
    const state = await issueState(ts);
    const res = await handleGithubInstalled(
      new Request(
        `https://dispatcher.example/v1/github/installed?code=c&state=${encodeURIComponent(state)}`,
      ),
      env,
      { now: ts, fetchImpl: fakeFetch(goodConversion()) },
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("surfaces GitHub exchange failures with the original status + body", async () => {
    const { env } = fixture();
    const ts = 1_700_000_000;
    const state = await issueState(ts);
    const errorFetch = (async () =>
      new Response("code expired or already used", {
        status: 404,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

    const res = await handleGithubInstalled(
      new Request(
        `https://dispatcher.example/v1/github/installed?code=stale&state=${encodeURIComponent(state)}`,
      ),
      env,
      { now: ts, fetchImpl: errorFetch },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("code expired or already used");
  });
});
