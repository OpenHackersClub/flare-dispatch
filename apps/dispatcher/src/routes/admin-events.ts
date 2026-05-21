// FlareDispatch Dispatcher — `POST /v1/admin/events/:wf_id`.
//
// The signalling endpoint behind `step.waitForEvent` (specs/03-dsl.md
// § Human-in-the-loop). A human (or an automation) POSTs `{type, payload}`;
// the Worker forwards it to the named Workflow via
// `env.RUNS_WORKFLOW.get(wf_id).sendEvent({type, payload})`, which resumes the
// matching `step.waitForEvent` checkpoint with the decoded payload.
//
// --- Auth: bearer-over-Access ------------------------------------------------
//
// Production deploys put Cloudflare Access in front of this route (the spec
// explicitly: "gated by Cloudflare Access"). The bearer-token gate here is
// the cheap-and-correct *inside-Access* defence-in-depth — it stops an
// internal misconfiguration that leaves the route open and means the route is
// usable on a deploy without CF Access in development. Compared against
// `ADMIN_TOKEN` with a constant-time comparison (constant-time across
// equal-length inputs; differing lengths short-circuit, which is fine —
// length itself is not secret).
//
// --- Out of scope ------------------------------------------------------------
//
// Receiver-level dedup on `(wf_id, decider_email)` (spec 03-dsl § Human-in-
// the-loop) is not implemented here; the spec describes it but no shipped
// run uses `step.waitForEvent` yet. Lands with the first run that does.

import type { Env } from "../env";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Constant-time-ish comparison for equal-length strings. */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/**
 * Handle `POST /v1/admin/events/:wf_id`.
 *
 * @param request  the inbound request — body is `{ type, payload }`.
 * @param env      binding env (`RUNS_WORKFLOW`, `ADMIN_TOKEN`).
 * @param wfId     the Workflow instance id to deliver the event to.
 */
export const handleAdminEvent = async (
  request: Request,
  env: Env,
  wfId: string,
): Promise<Response> => {
  // 1. Opt-in: refuse if no admin token is provisioned. Better than silently
  //    accepting unauthenticated event signals into a Workflow.
  if (env.ADMIN_TOKEN === undefined) {
    return json(
      {
        error: "admin_not_configured",
        message:
          "ADMIN_TOKEN is unset; the admin events surface is off on this deploy",
      },
      503,
    );
  }

  // 2. Bearer-token gate.
  const auth = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.ADMIN_TOKEN}`;
  if (!safeEqual(auth, expected)) {
    return json(
      { error: "unauthorized", message: "Authorization bearer token missing or invalid" },
      401,
    );
  }

  // 3. Parse body.
  let body: { type?: unknown; payload?: unknown };
  try {
    body = (await request.json()) as { type?: unknown; payload?: unknown };
  } catch (cause) {
    return json(
      {
        error: "invalid_json",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      400,
    );
  }
  if (typeof body.type !== "string" || body.type.length === 0) {
    return json(
      { error: "invalid_body", message: "`type` is required and must be a non-empty string" },
      400,
    );
  }

  // 4. Forward to the Workflow. `.get()` returns a handle even for an
  //    unknown id; `sendEvent` rejects when the id isn't a running instance.
  try {
    const handle = env.RUNS_WORKFLOW.get(wfId);
    // sendEvent isn't on the older Workflow binding types; the cast keeps
    // the runtime call typed once CF's types catch up.
    const sendEvent = (handle as unknown as {
      sendEvent?: (e: { type: string; payload: unknown }) => Promise<void>;
    }).sendEvent;
    if (typeof sendEvent !== "function") {
      return json(
        {
          error: "platform_not_supported",
          message:
            "this Workflow binding does not expose `sendEvent` — upgrade wrangler / compatibility_date",
        },
        501,
      );
    }
    await sendEvent.call(handle, { type: body.type, payload: body.payload });
    return json({ delivered: true, wfId, type: body.type }, 202);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // CF Workflows raises distinct errors for unknown vs. terminated; the
    // signature is unstable across versions, so we keep this narrow.
    if (/not.?found|unknown.?instance/i.test(message)) {
      return json(
        { error: "wf_not_found", wfId, message },
        404,
      );
    }
    return json(
      { error: "send_event_failed", wfId, message },
      502,
    );
  }
};
