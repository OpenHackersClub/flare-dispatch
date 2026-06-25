// FlareDispatch Dispatcher — the HTTP surface as an `@effect/platform` router.
//
// Replaces the hand-rolled method+path matcher with a typed `HttpRouter`: path
// params come from the router, the Cloudflare Access gate and the per-execution
// capability links are typed PORTS (ports.ts) provided as Layers, and the new
// `GET /` dashboard is a first-class route. `handleRequest` (router.ts) provides
// the request-scoped ports and hands this router to `HttpApp.toWebHandler`.
//
// Behavioural parity with the old matcher is deliberate and load-bearing — the
// whole test suite drives `handleRequest` and asserts exact 404 `not_found` /
// 405 `method_not_allowed` bodies and the "Access gate runs before the method
// check on viewer surfaces" ordering. So each route is registered with
// `HttpRouter.all` and guards its own method, returning the same JSON shapes.
//
// Two surfaces are intentionally NOT here, handled as pre-router escape hatches
// in router.ts / index.ts because they don't return an ordinary HTTP response
// the `HttpServerResponse` model can round-trip:
//   * `GET /v1/browser/cdp` — a WebSocket `101` upgrade carrying a `webSocket`.
//   * the `@cloudflare/sandbox` preview-port proxy (index.ts).
//
// Legacy route handlers still return a web `Response` (their own tests assert on
// it); `fromWebResponse` wraps each as an `HttpServerResponse` WITHOUT buffering
// — the body `ReadableStream` is passed straight through, so R2 artifact/log
// streaming is preserved.

import {
  HttpApp,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, Option } from "effect";

import { CurrentEnv, ExecutionsRead, LogToken, portsLayer, Access } from "./ports";
import { renderDashboard, type DashboardRow } from "./dashboard";
import type { Env } from "./env";
import { handleAdminEvent } from "./routes/admin-events";
import { handleAgentInference } from "./routes/agent-inference";
import { handleArtifact } from "./routes/artifacts";
import { handleDispatch } from "./routes/dispatch";
import {
  handleExecutionDetail,
  handleExecutionsList,
} from "./routes/executions";
import { handleHealth } from "./routes/health";
import {
  handleInstallLlms,
  handleInstallNew,
  handleInstalled,
} from "./routes/github";
import { handleLogFile, handleLogsAggregate, handleLogViewer } from "./routes/logs";
import { handleOidcDiscovery, handleOidcJwks } from "./routes/oidc";
import { handleProductDemo } from "./routes/product-demos";
import { handleReplay } from "./routes/replay";
import { handleGithubWebhook } from "./routes/webhook";
import { handleSignalsWebhook } from "./routes/signals-webhook";

/** `owner/repo` slug for the dashboard source link. */
const REPO_SLUG = "OpenHackersClub/flare-dispatch";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** A JSON error response, byte-compatible with the old `json()` helper. */
const jsonResponse = (
  body: unknown,
  status: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const notFound = jsonResponse({ error: "not_found" }, 404);
const methodNotAllowed = jsonResponse({ error: "method_not_allowed" }, 405);

/**
 * Wrap a web `Response` (possibly a streaming body) as an `HttpServerResponse`
 * without reading/buffering it — the body stream is passed straight through.
 */
const fromWebResponse = (res: Response): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(res.body, {
    status: res.status,
    statusText: res.statusText.length > 0 ? res.statusText : undefined,
    headers: Object.fromEntries(res.headers),
  });

/**
 * Per-request sink for an error a legacy handler THREW (rather than returned).
 * The old matcher had no try/catch, so a throwing handler rejected
 * `handleRequest` — `index.ts`'s `fetch` then rejected and Cloudflare logged the
 * crash + returned a 500. `toWebHandler` instead swallows defects into a clean
 * 500, so we record the original error here and `handleViaApp` rethrows it,
 * restoring the propagation semantics the suite pins (dispatch storage errors).
 */
class DefectSink extends Context.Tag("dispatcher/DefectSink")<
  DefectSink,
  { readonly record: (error: unknown) => void }
>() {}

/**
 * Invoke a legacy handler. On success, stream its `Response` back; on a thrown
 * error, record it in the `DefectSink` (so `handleViaApp` rethrows) and emit a
 * placeholder 500 — discarded, since the rethrow happens before it is returned.
 */
const runLegacy = (thunk: () => Promise<Response> | Response) =>
  Effect.tryPromise({
    try: async () => thunk(),
    catch: (error) => error,
  }).pipe(
    Effect.map(fromWebResponse),
    Effect.catchAll((error) =>
      DefectSink.pipe(
        Effect.flatMap((sink) => {
          sink.record(error);
          return Effect.succeed(jsonResponse({ error: "internal_error" }, 500));
        }),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Per-request accessors
// ---------------------------------------------------------------------------

/** The original inbound web `Request` (preserves the unread body stream). */
const currentRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((req) => req.source as Request),
);

/** Run the Access gate; `Some(response)` to return as-is, `None` to proceed. */
const accessGate = (request: Request): Effect.Effect<Option.Option<Response>, never, Access> =>
  Access.pipe(Effect.flatMap((access) => access.gate(request)));

type Params = Readonly<Record<string, string | undefined>>;
type RouteArgs = {
  readonly request: Request;
  readonly url: URL;
  readonly env: Env;
  readonly params: Params;
};
type Produce = (args: RouteArgs) => Promise<Response> | Response;

/**
 * Build a single-method route handler. Mirrors the old matcher exactly:
 *   * `viewer` routes run the Access gate FIRST (its 503/403 wins over a 405),
 *   * a method mismatch on a known path → `405 method_not_allowed`,
 *   * otherwise the legacy handler's `Response` is streamed back.
 */
const route = (
  method: "GET" | "POST",
  produce: Produce,
  opts?: { readonly viewer?: boolean },
) =>
  Effect.gen(function* () {
    const request = yield* currentRequest;
    if (opts?.viewer === true) {
      const denied = yield* accessGate(request);
      if (Option.isSome(denied)) return fromWebResponse(denied.value);
    }
    if (request.method !== method) return methodNotAllowed;
    const env = yield* CurrentEnv;
    const params = yield* HttpRouter.params;
    const url = new URL(request.url);
    return yield* runLegacy(() => produce({ request, url, env, params }));
  });

const decode = (params: Params, key: string): string =>
  decodeURIComponent(params[key] ?? "");

/**
 * A GET viewer route whose handler is itself an Effect over the ports (the
 * executions/logs read routes). Gates first, then runs the handler within the
 * router's Layer context, streaming its `Response` back. A thrown error (an
 * Effect defect from a rejected dependency) is recorded in the `DefectSink` so
 * `handleViaApp` rethrows it — same propagation as `runLegacy`.
 */
const routeEffect = (
  make: (args: {
    readonly request: Request;
    readonly url: URL;
    readonly params: Params;
  }) => Effect.Effect<Response, never, CurrentEnv | ExecutionsRead | LogToken>,
) =>
  Effect.gen(function* () {
    const request = yield* currentRequest;
    const denied = yield* accessGate(request);
    if (Option.isSome(denied)) return fromWebResponse(denied.value);
    if (request.method !== "GET") return methodNotAllowed;
    const params = yield* HttpRouter.params;
    const url = new URL(request.url);
    return yield* make({ request, url, params }).pipe(
      Effect.map(fromWebResponse),
      Effect.catchAllDefect((defect) =>
        DefectSink.pipe(
          Effect.flatMap((sink) => {
            sink.record(defect);
            return Effect.succeed(jsonResponse({ error: "internal_error" }, 500));
          }),
        ),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Bespoke routes
// ---------------------------------------------------------------------------

/**
 * Resolve the latest executions into `DashboardRow`s with their tokened viewer
 * links. Shared by the SSR `GET /` page and the `GET /v1/dashboard.json` feed
 * the static-asset SPA consumes — one D1 read + token-minting path, two renders.
 */
const dashboardData = Effect.gen(function* () {
  const env = yield* CurrentEnv;
  const reads = yield* ExecutionsRead;
  const logTokens = yield* LogToken;
  const request = yield* currentRequest;
  const url = new URL(request.url);
  const origin = env.PUBLIC_ORIGIN ?? url.origin;

  const rows = yield* reads.list({ limit: 20 });
  const dashRows = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const logsUrl = yield* logTokens.logsUrl(origin, row.id);
      const demosUrl =
        row.run === "product-demo"
          ? yield* logTokens.demosUrl(origin, row.id)
          : Option.none<string>();
      return {
        id: row.id,
        run: row.run,
        repo: row.repo,
        ref: row.ref,
        sha: row.sha,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        logsUrl: Option.getOrNull(logsUrl),
        demosUrl: Option.getOrNull(demosUrl),
      } satisfies DashboardRow;
    }),
  );
  return { origin, rows: dashRows };
});

/**
 * `GET /` — the SSR dashboard. With the Workers Static Assets binding wired
 * (wrangler.jsonc), production serves the SPA shell from `apps/dashboard/dist`
 * for `/` and the asset layer never reaches this route; it remains the zero-JS
 * fallback (no-asset deploys) and the surface the route tests drive. A viewer
 * surface, so Access-gated like the rest.
 */
const dashboardRoute = Effect.gen(function* () {
  const request = yield* currentRequest;
  const denied = yield* accessGate(request);
  if (Option.isSome(denied)) return fromWebResponse(denied.value);
  if (request.method !== "GET") return methodNotAllowed;

  const { origin, rows } = yield* dashboardData;
  const html = renderDashboard({
    origin,
    rows,
    nowMs: Date.now(),
    repoSlug: REPO_SLUG,
  });
  return HttpServerResponse.raw(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

/**
 * `GET /v1/dashboard.json` — the executions feed for the static-asset SPA. Same
 * Access gate + tokened links as the SSR page, returned as JSON so the SPA shell
 * (served publicly from assets) can render the list only once the operator's
 * Access cookie lets this request through. Listed under `run_worker_first`
 * (wrangler.jsonc) so the SPA fallback never shadows it.
 */
const dashboardJsonRoute = Effect.gen(function* () {
  const request = yield* currentRequest;
  const denied = yield* accessGate(request);
  if (Option.isSome(denied)) return fromWebResponse(denied.value);
  if (request.method !== "GET") return methodNotAllowed;

  const { origin, rows } = yield* dashboardData;
  return HttpServerResponse.raw(
    JSON.stringify({ origin, repoSlug: REPO_SLUG, rows }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
});

/** `POST/GET /v1/agent/:execution/inference` — no method guard (any verb). */
const agentInferenceRoute = Effect.gen(function* () {
  const request = yield* currentRequest;
  const env = yield* CurrentEnv;
  const params = yield* HttpRouter.params;
  const requestId = request.headers.get("cf-ray") ?? "no-ray";
  return yield* runLegacy(() =>
    handleAgentInference(request, env, decode(params, "execution"), requestId),
  );
});

/**
 * `GET /v1/artifacts/:execution/:name[/...path]`. Recomputes name + sub-path
 * from the raw pathname (not router params) to preserve the old segment-exact
 * behaviour, including the trailing-slash "browse entrypoint" signal.
 */
const artifactsRoute = Effect.gen(function* () {
  const request = yield* currentRequest;
  if (request.method !== "GET") return methodNotAllowed;
  const env = yield* CurrentEnv;
  const url = new URL(request.url);
  const segs = url.pathname.split("/").filter((s) => s.length > 0);
  const subPath = segs
    .slice(4)
    .map((s) => decodeURIComponent(s))
    .join("/");
  return yield* runLegacy(() =>
    handleArtifact(
      env,
      decodeURIComponent(segs[2] ?? ""),
      decodeURIComponent(segs[3] ?? ""),
      subPath,
      url.pathname.endsWith("/"),
    ),
  );
});

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

const baseRouter = HttpRouter.empty.pipe(
  HttpRouter.all("/", dashboardRoute),
  HttpRouter.all("/health", route("GET", () => handleHealth())),
  HttpRouter.all(
    "/replay/:sessionId",
    route("GET", ({ env, params }) => handleReplay(env, decode(params, "sessionId")), {
      viewer: true,
    }),
  ),
  HttpRouter.all(
    "/demos/:execution",
    route(
      "GET",
      ({ env, params, url }) => handleProductDemo(env, decode(params, "execution"), url),
      { viewer: true },
    ),
  ),
  HttpRouter.all(
    "/logs/:execution",
    route(
      "GET",
      ({ env, params, url }) => handleLogViewer(env, decode(params, "execution"), url),
      { viewer: true },
    ),
  ),
  HttpRouter.all(
    "/.well-known/openid-configuration",
    route("GET", ({ env }) => handleOidcDiscovery(env)),
  ),
  HttpRouter.all(
    "/.well-known/jwks.json",
    route("GET", ({ env }) => handleOidcJwks(env)),
  ),
);

// Second chain — `pipe` caps at 20 combinators, so the route table is split
// across two `.pipe` calls over the same accumulating router.
const router = baseRouter.pipe(
  HttpRouter.all(
    "/v1/dispatch/:run",
    route("POST", ({ request, env, params }) =>
      handleDispatch(request, env, decode(params, "run")),
    ),
  ),
  HttpRouter.all(
    "/v1/webhooks/github",
    route("POST", ({ request, env }) => handleGithubWebhook(request, env)),
  ),
  HttpRouter.all(
    "/v1/webhooks/signals/:source",
    route("POST", ({ request, env, params }) =>
      handleSignalsWebhook(request, env, decode(params, "source")),
    ),
  ),
  HttpRouter.all("/v1/agent/:execution/inference", agentInferenceRoute),
  HttpRouter.all(
    "/v1/admin/events/:wf_id",
    route("POST", ({ request, env, params }) =>
      handleAdminEvent(request, env, decode(params, "wf_id")),
    ),
  ),
  HttpRouter.all(
    "/v1/executions",
    routeEffect(({ request, url }) => handleExecutionsList(request, url)),
  ),
  HttpRouter.all(
    "/v1/executions/:id/logs/:file",
    routeEffect(({ params, url }) =>
      handleLogFile(decode(params, "id"), decode(params, "file"), url),
    ),
  ),
  HttpRouter.all(
    "/v1/executions/:id/logs",
    routeEffect(({ params, url }) => handleLogsAggregate(decode(params, "id"), url)),
  ),
  HttpRouter.all(
    "/v1/executions/:id",
    routeEffect(({ params, url }) => handleExecutionDetail(decode(params, "id"), url)),
  ),
  HttpRouter.all("/v1/artifacts/:execution/:name", artifactsRoute),
  HttpRouter.all("/v1/artifacts/:execution/:name/*", artifactsRoute),
  HttpRouter.all(
    "/v1/github/install/new",
    route("GET", ({ request }) => handleInstallNew(request)),
  ),
  HttpRouter.all(
    "/v1/github/install/llms.txt",
    route("GET", ({ request }) => handleInstallLlms(request)),
  ),
  HttpRouter.all(
    "/v1/github/installed",
    route("GET", ({ request }) => handleInstalled(request)),
  ),
  HttpRouter.all("/v1/dashboard.json", dashboardJsonRoute),
  HttpRouter.all("/*", Effect.succeed(notFound)),
);

/**
 * Route a request through the typed router with this request's bindings. Builds
 * the web handler per request so the `CurrentEnv` Layer carries the right `Env`.
 */
export const handleViaApp = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  let escaped: { readonly value: unknown } | null = null;
  const sink: { record: (error: unknown) => void } = {
    record: (value) => {
      escaped = { value };
    },
  };
  const handler = HttpApp.toWebHandler(
    router.pipe(
      Effect.provide(portsLayer(env)),
      Effect.provideService(DefectSink, sink),
    ),
  );
  const response = await handler(request);
  // A legacy handler THREW — propagate it as a rejection, matching the old
  // matcher (and so index.ts's fetch rejects → Cloudflare logs the crash).
  if (escaped !== null) throw (escaped as { value: unknown }).value;
  return response;
};
