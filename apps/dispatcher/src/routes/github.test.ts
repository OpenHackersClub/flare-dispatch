// FlareDispatch Dispatcher — `routes/github.ts` acceptance tests.
//
// Drives the two new endpoints against a stubbed GitHub API (msw):
//
//   GET /v1/github/install/new   → renders auto-submitting form with
//                                  origin-substituted manifest.
//   GET /v1/github/installed     → POSTs to /app-manifests/{code}/conversions,
//                                  renders success or error page.
//
// XSS-escape regression: a mocked GitHub response with `<script>` / `"` in
// fields is asserted to be HTML-escaped on the rendered page.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { handleRequest } from "../router";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import { handleInstallNew, htmlEscape } from "./github";

const HMAC_SECRET = "github-route-tests-secret-please-rotate";

const makeEnv = () => {
  const workflow = makeFakeWorkflow();
  const storage = makeFakeR2();
  return makeFakeEnv({ hmacSecret: HMAC_SECRET, workflow, storage });
};

const ORIGIN = "https://flare-dispatch-v0.example.test";
const INSTALL_NEW_URL = `${ORIGIN}/v1/github/install/new`;
const INSTALLED_URL = `${ORIGIN}/v1/github/installed`;

// ---------------------------------------------------------------------------
// `htmlEscape` — the helper everything else depends on.
// ---------------------------------------------------------------------------

describe("htmlEscape", () => {
  it("escapes & < > \" ' to their entities", () => {
    expect(htmlEscape(`<script>alert("x'y")</script>&`)).toBe(
      "&lt;script&gt;alert(&quot;x&#39;y&quot;)&lt;/script&gt;&amp;",
    );
  });

  it("escapes `&` first so existing entities don't get double-decoded", () => {
    // If we replaced `&` LAST, an input of `&lt;` would become `&amp;lt;`
    // (correct) but `<` would have already been turned into `&lt;` and would
    // then re-encode to `&amp;lt;` — wrong. Test the ordering directly.
    expect(htmlEscape("&lt;")).toBe("&amp;lt;");
  });
});

// ---------------------------------------------------------------------------
// `GET /v1/github/install/new`
// ---------------------------------------------------------------------------

describe("GET /v1/github/install/new", () => {
  it("returns 200 text/html with auto-submitting form pointed at github.com", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request(INSTALL_NEW_URL), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const body = await res.text();
    // Form action lands at GitHub's manifest-create endpoint with a state.
    expect(body).toMatch(
      /<form[^>]+method="post"[^>]+action="https:\/\/github\.com\/settings\/apps\/new\?state=[^"]+"/,
    );
    // Auto-submit script + no-JS fallback button both present.
    expect(body).toContain("document.getElementById('manifest-form').submit()");
    expect(body).toContain("<noscript>");
  });

  it("substitutes the request origin into manifest url, hook_attributes.url, and redirect_url", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request(INSTALL_NEW_URL), env);
    const body = await res.text();

    // Extract the hidden manifest value — the HTML attribute is escaped, so
    // we run the page output through reverse-escape on the captured group.
    const match = body.match(
      /<input type="hidden" name="manifest" value="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    const escaped = match![1]!;
    // Reverse the entities we know we produce. `&quot;` is the load-bearing
    // one for JSON; the rest are belt-and-braces.
    const json = escaped
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    const manifest = JSON.parse(json) as {
      url: string;
      hook_attributes: { url: string };
      redirect_url: string;
    };

    expect(manifest.url).toBe(ORIGIN);
    expect(manifest.hook_attributes.url).toBe(`${ORIGIN}/v1/webhooks/github`);
    expect(manifest.redirect_url).toBe(`${ORIGIN}/v1/github/installed`);
    // The placeholder host MUST be gone from every URL.
    expect(JSON.stringify(manifest)).not.toContain("runs.example.com");
  });

  it("works against a localhost origin (wrangler dev)", async () => {
    // `handleInstallNew` is exported directly so we can unit-test the origin
    // logic without the router's text-only assertions.
    const res = handleInstallNew(
      new Request("http://localhost:8787/v1/github/install/new"),
    );
    const body = await res.text();
    expect(body).toContain("http://localhost:8787/v1/github/installed");
    expect(body).toContain("http://localhost:8787/v1/webhooks/github");
  });

  it("405s a non-GET method", async () => {
    const env = makeEnv();
    const res = await handleRequest(
      new Request(INSTALL_NEW_URL, { method: "POST" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// `GET /v1/github/installed`
// ---------------------------------------------------------------------------

/** A canonical, well-formed conversion response — what GitHub returns on success. */
const validConversion = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  slug: "flaredispatch-test",
  name: "FlareDispatch (test)",
  html_url: "https://github.com/apps/flaredispatch-test",
  webhook_secret: "wh_secret_xyz",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...keyline2...keyline3...\n-----END RSA PRIVATE KEY-----",
  client_id: "Iv1.abc123def456",
  client_secret: "client_secret_value",
  ...overrides,
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("GET /v1/github/installed", () => {
  it("exchanges code, renders success page with slug + wrangler commands + install URL", async () => {
    server.use(
      http.post(
        "https://api.github.com/app-manifests/:code/conversions",
        () => HttpResponse.json(validConversion()),
      ),
    );

    const env = makeEnv();
    const res = await handleRequest(
      new Request(`${INSTALLED_URL}?code=somecode&state=somestate`),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const body = await res.text();
    expect(body).toContain("flaredispatch-test"); // slug
    expect(body).toContain("FlareDispatch (test)"); // name
    expect(body).toContain("wrangler secret put GITHUB_APP_ID");
    expect(body).toContain("wrangler secret put GITHUB_WEBHOOK_SECRET");
    expect(body).toContain("wrangler secret put GITHUB_APP_PRIVATE_KEY");
    expect(body).toContain("wrangler secret put GITHUB_APP_CLIENT_ID");
    expect(body).toContain("wrangler secret put GITHUB_APP_CLIENT_SECRET");
    // The displayed secret values
    expect(body).toContain("wh_secret_xyz");
    expect(body).toContain("Iv1.abc123def456");
    expect(body).toContain("client_secret_value");
    // PEM rendered inside the page so the operator can copy it.
    expect(body).toContain("-----BEGIN RSA PRIVATE KEY-----");
    // Install URL is `<html_url>/installations/new`.
    expect(body).toContain(
      "https://github.com/apps/flaredispatch-test/installations/new",
    );
    // The "shown once" warning is present.
    expect(body.toLowerCase()).toContain("once");
  });

  it("HTML-escapes XSS payloads carried in any conversion field", async () => {
    // A hostile or buggy upstream returning fields containing `<script>` or
    // `"` MUST render escaped — not as live markup.
    server.use(
      http.post(
        "https://api.github.com/app-manifests/:code/conversions",
        () =>
          HttpResponse.json(
            validConversion({
              name: '<script>alert("x")</script>',
              slug: 'bad"slug',
              webhook_secret: "<img src=x onerror=alert(1)>",
            }),
          ),
      ),
    );

    const env = makeEnv();
    const res = await handleRequest(
      new Request(`${INSTALLED_URL}?code=somecode`),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();

    // No live `<script>alert` token — every `<` and `>` in the field MUST be
    // escaped to `&lt;` / `&gt;`. The page itself contains a legit `<script>`
    // for the install/new auto-submit, but that's on a different page; the
    // success page has no `<script>` tag of its own, so a literal
    // `<script>alert(` from the field would be the only place it could appear.
    expect(body).not.toContain('<script>alert("x")');
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // Quote in `slug` escaped.
    expect(body).toContain("bad&quot;slug");
    expect(body).not.toContain('bad"slug');
    // `<img` payload escaped to `&lt;img`.
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("502s with an error page when GitHub returns 422", async () => {
    // Hostile-looking body — must NOT survive verbatim into the page.
    const hostileBody =
      '{"message":"code expired","details":"<script>alert(1)</script>"}';
    server.use(
      http.post(
        "https://api.github.com/app-manifests/:code/conversions",
        () =>
          new HttpResponse(hostileBody, {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const env = makeEnv();
    const res = await handleRequest(
      new Request(`${INSTALLED_URL}?code=expired`),
      env,
    );

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const body = await res.text();
    expect(body).toContain("App creation failed");
    // Status mentioned for the operator.
    expect(body).toContain("422");
    // Raw `<script>` from the upstream body MUST be escaped.
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("400 JSON when code query param is missing", async () => {
    const env = makeEnv();
    const res = await handleRequest(new Request(INSTALLED_URL), env);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("missing_code");
  });

  it("400 JSON when code query param is empty", async () => {
    const env = makeEnv();
    const res = await handleRequest(
      new Request(`${INSTALLED_URL}?code=`),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("502 when GitHub returns 200 with an unexpected body shape", async () => {
    server.use(
      http.post(
        "https://api.github.com/app-manifests/:code/conversions",
        () => HttpResponse.json({ unexpected: "shape" }),
      ),
    );
    const env = makeEnv();
    const res = await handleRequest(
      new Request(`${INSTALLED_URL}?code=somecode`),
      env,
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("App creation failed");
  });

  it("405s a non-GET method", async () => {
    const env = makeEnv();
    const res = await handleRequest(
      new Request(INSTALLED_URL, { method: "POST" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});
