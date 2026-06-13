// FlareDispatch Dispatcher — log + executions route tests.
//
// Drives the `handleRequest` router with a hand-built `Request` + fake Env
// (test-helpers.ts), exercising the capability-token gate, the NDJSON / text
// log formats, the aggregate roll-up, the ADMIN_TOKEN listing gate, and the
// HTML viewer's CSP. Same Vitest-2-only pattern as index.test.ts.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { signLogToken } from "../log-token";
import { makeNdjsonTextTransform, recordToText } from "./logs";
import {
  makeFakeD1,
  makeFakeEnv,
  makeFakeR2,
  makeFakeWorkflow,
} from "../test-helpers";

const SECRET = "log-secret-please-rotate";
const ORIGIN = "https://dispatcher.example";
const EXEC = "offload-test:owner_repo:abc123def456";

/** An NDJSON exec log body the way `SandboxCloudflareLive.writeLog` writes it. */
const ndjson = (command: string, stdout: string[], stderr: string[] = []): string =>
  [
    JSON.stringify({ stream: "meta", command }),
    ...stdout.map((line) => JSON.stringify({ stream: "stdout", line })),
    ...stderr.map((line) => JSON.stringify({ stream: "stderr", line })),
  ].join("\n") + "\n";

const fixture = (opts: { adminToken?: string } = {}) => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  const metadata = makeFakeD1({
    executions: [
      {
        id: EXEC,
        run: "offload-test",
        repo: "owner/repo",
        ref: "refs/heads/main",
        sha: "abc123def456789",
        status: "success",
        started_at: 1000,
        completed_at: 2000,
        parent_execution_id: null,
        input_json: JSON.stringify({ secret: "should-not-leak" }),
        summary_json: JSON.stringify({ ok: true }),
        check_run_id: null,
      },
    ],
    steps: [
      {
        id: `${EXEC}:checkout:1`,
        execution_id: EXEC,
        name: "checkout",
        status: "success",
        started_at: 1000,
        completed_at: 1100,
        exit_code: 0,
        log_uri: null,
        attempt: 1,
      },
    ],
  });
  storage.put(
    `logs/${EXEC}/exec.ndjson`,
    ndjson("pnpm test", ["building…", "ok"], ["a warning"]),
    "application/x-ndjson",
  );
  storage.put(
    `logs/${EXEC}/exec-2.ndjson`,
    ndjson("pnpm build", ["bundle done"]),
    "application/x-ndjson",
  );
  const env = makeFakeEnv({
    hmacSecret: "h",
    workflow,
    storage,
    metadata,
    logLinkSecret: SECRET,
    publicOrigin: ORIGIN,
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
  });
  return { env };
};

const get = (env: ReturnType<typeof fixture>["env"], path: string, headers?: Record<string, string>) =>
  handleRequest(new Request(`${ORIGIN}${path}`, { headers }), env);

describe("NDJSON → text", () => {
  it("maps records to lines", () => {
    expect(recordToText({ stream: "meta", command: "pnpm test" })).toBe("$ pnpm test\n");
    expect(recordToText({ stream: "stdout", line: "hi" })).toBe("hi\n");
    expect(recordToText({ stream: "stderr", line: "boom" })).toBe("[stderr] boom\n");
    expect(recordToText({ stream: "other" })).toBe(null);
  });

  it("transforms a streamed NDJSON body across chunk boundaries", async () => {
    const body = ndjson("echo", ["one", "two"], ["err"]);
    // Split mid-line to exercise the line buffer.
    const mid = Math.floor(body.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(body.slice(0, mid)));
        c.enqueue(enc.encode(body.slice(mid)));
        c.close();
      },
    });
    const out = await new Response(
      stream.pipeThrough(makeNdjsonTextTransform()),
    ).text();
    expect(out).toBe("$ echo\none\ntwo\n[stderr] err\n");
  });
});

describe("log routes — token gate", () => {
  it("403s without a token", async () => {
    const { env } = fixture();
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson`);
    expect(res.status).toBe(403);
  });

  it("403s with a wrong token", async () => {
    const { env } = fixture();
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=0000000000000000000000`,
    );
    expect(res.status).toBe(403);
  });

  it("400s on a malformed execution id", async () => {
    const { env } = fixture();
    const res = await get(env, `/v1/executions/a%20b/logs/exec.ndjson?t=x`);
    expect(res.status).toBe(400);
  });

  it("serves the raw NDJSON with a valid token + nosniff", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("immutable"); // terminal
  });

  it("serves ?format=text rendered output", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(
      env,
      `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec.ndjson?t=${t}&format=text`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("$ pnpm test\nbuilding…\nok\n[stderr] a warning\n");
  });

  it("404s a non-existent but well-formed log file", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/exec-9.ndjson?t=${t}`);
    expect(res.status).toBe(404);
  });

  it("rejects a log file name that is not an exec log", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs/secrets.env?t=${t}`);
    expect(res.status).toBe(400);
  });

  it("aggregates all exec logs in order", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}/logs?t=${t}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.indexOf("exec.ndjson")).toBeLessThan(text.indexOf("exec-2.ndjson"));
    expect(text).toContain("$ pnpm build");
  });
});

describe("GET /v1/executions/:id", () => {
  it("returns steps + log index but never input_json", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/v1/executions/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
    expect((body.steps as unknown[]).length).toBe(1);
    expect((body.logs as { file: string }[]).map((l) => l.file)).toContain(
      "exec.ndjson",
    );
    expect(body.summary).toEqual({ ok: true });
  });

  it("404s an unknown execution (with a valid-shape token)", async () => {
    const { env } = fixture();
    const id = "missing:owner_repo:000000000000";
    const t = await signLogToken(SECRET, id);
    const res = await get(env, `/v1/executions/${encodeURIComponent(id)}?t=${t}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/executions (listing)", () => {
  it("503s when ADMIN_TOKEN is unset", async () => {
    const { env } = fixture();
    expect((await get(env, `/v1/executions`)).status).toBe(503);
  });

  it("401s with a bad bearer", async () => {
    const { env } = fixture({ adminToken: "admin-secret" });
    const res = await get(env, `/v1/executions`, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("lists executions with the bearer, attaching tokened logsUrl", async () => {
    const { env } = fixture({ adminToken: "admin-secret" });
    const res = await get(env, `/v1/executions?run=offload-test`, {
      Authorization: "Bearer admin-secret",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executions: { id: string; logsUrl?: string }[] };
    expect(body.executions[0]!.id).toBe(EXEC);
    expect(body.executions[0]!.logsUrl).toContain("/logs/");
    expect(body.executions[0]!.logsUrl).toContain("?t=");
  });
});

describe("GET /logs/:execution (viewer)", () => {
  it("serves HTML with a strict CSP under a valid token", async () => {
    const { env } = fixture();
    const t = await signLogToken(SECRET, EXEC);
    const res = await get(env, `/logs/${encodeURIComponent(EXEC)}?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("403s the viewer without a token", async () => {
    const { env } = fixture();
    const res = await get(env, `/logs/${encodeURIComponent(EXEC)}`);
    expect(res.status).toBe(403);
  });
});
