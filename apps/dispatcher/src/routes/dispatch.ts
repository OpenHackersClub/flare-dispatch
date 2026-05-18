// FlareDispatch Dispatcher — `POST /v1/dispatch/:run`.
//
// The dispatch path: a GHA Action (or any HMAC-signing caller) POSTs a dispatch
// body; the Dispatcher verifies it, validates it, and instantiates a
// `RunWorkflow` execution. Per specs/04-gha-integration.md § Failure handling
// the contract is:
//
//   401  HMAC missing/mismatch          — config bug, NO retry
//   404  unknown run name               — run not on this deploy
//   400  body / inputs fail Schema      — Schema parse error inlined in body
//   202  accepted                       — `{ "executionId": "<ulid>" }`
//
// --- Read order: verify, THEN parse ------------------------------------------
//
// The body is read ONCE as raw bytes (`request.arrayBuffer()`), HMAC-verified
// against those exact bytes (see hmac.ts — raw-bytes canonicalization is locked
// per plan § 6), and only then JSON-parsed. Verifying the raw bytes before any
// parse is what makes the raw-bytes contract hold: a parse-then-reserialize
// would change the octets and break the MAC.
//
// Spec: specs/04-gha-integration.md § Dispatch body + § Failure handling,
//       specs/05-byoc.md § Security posture, specs/pm/plan.md § PR5.

import { Either, ParseResult, Schema } from "effect";
import type { ParseError } from "effect/ParseResult";
import type { Env } from "../env";
import { SIGNATURE_HEADER, verify } from "../hmac";
import { lookupRun } from "../registry";
import { ulid } from "../ulid";

/** JSON helper — a `Response` with the right content-type. */
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The `github` context a dispatch carries — specs/04-gha-integration.md
 * § Dispatch body. `installation_id` is REQUIRED here (and forwarded into the
 * Workflow `params`) even though PR5 does not consume it: PR6's check-run
 * callback needs it to mint an installation token. `pr_number` / `actor` are
 * optional metadata.
 */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, {
    default: () => "refs/heads/main",
  }),
  sha: Schema.String,
  pr_number: Schema.optional(Schema.Number),
  actor: Schema.optional(Schema.String),
  installation_id: Schema.Number,
});

/**
 * The dispatch body — specs/04-gha-integration.md § Dispatch body. `inputs` is
 * left `Unknown` here and validated separately against the *named run's*
 * `inputs` Schema, so the 400 carries the run-specific parse error.
 */
const DispatchBody = Schema.Struct({
  run: Schema.String,
  github: GithubContext,
  inputs: Schema.Unknown,
  trigger: Schema.optional(Schema.Unknown),
});

/** Render an Effect `ParseError` as the multi-line tree a caller can act on. */
const formatParseError = (error: ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

/**
 * Handle `POST /v1/dispatch/:run`.
 *
 * @param request   the inbound request — body read once as raw bytes.
 * @param env       binding env (`HMAC_SECRET`, `RUNS_WORKFLOW`).
 * @param runName   the `:run` path segment.
 */
export const handleDispatch = async (
  request: Request,
  env: Env,
  runName: string,
): Promise<Response> => {
  // 1. Read the raw body bytes ONCE — this is what the HMAC is computed over.
  const rawBody = await request.arrayBuffer();

  // 2. HMAC-verify the raw bytes. Missing/mismatched → 401, no retry.
  const signature = request.headers.get(SIGNATURE_HEADER);
  const signatureOk = await verify(env.HMAC_SECRET, signature, rawBody);
  if (!signatureOk) {
    return json(
      { error: "unauthorized", message: "HMAC signature missing or invalid" },
      401,
    );
  }

  // 3. Unknown run name → 404. (Checked after HMAC so an unauthenticated
  //    caller cannot probe which runs exist.)
  const run = lookupRun(runName);
  if (run === undefined) {
    return json(
      {
        error: "run_not_found",
        message: `unknown run "${runName}"`,
        run: runName,
      },
      404,
    );
  }

  // 4. Parse the body as JSON, then Schema-validate the envelope. A parse
  //    failure or an envelope-shape mismatch is a 400 with the error inlined.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (cause) {
    return json(
      {
        error: "invalid_body",
        message: "request body is not valid JSON",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      400,
    );
  }

  const bodyResult = Schema.decodeUnknownEither(DispatchBody)(parsed);
  const body = Either.getOrUndefined(bodyResult);
  if (body === undefined) {
    return json(
      {
        error: "invalid_body",
        message: "dispatch body failed schema validation",
        detail: Either.match(bodyResult, {
          onLeft: formatParseError,
          onRight: () => "",
        }),
      },
      400,
    );
  }

  // 5. Validate `inputs` against the *named run's* own Schema — the 400 here
  //    carries the run-specific parse error.
  const inputsResult = Schema.decodeUnknownEither(run.inputs)(body.inputs);
  const inputs = Either.getOrUndefined(inputsResult);
  if (inputs === undefined) {
    return json(
      {
        error: "invalid_inputs",
        message: `inputs failed schema validation for run "${runName}"`,
        detail: Either.match(inputsResult, {
          onLeft: formatParseError,
          onRight: () => "",
        }),
      },
      400,
    );
  }

  // 6. Accepted — mint a ULID, build the Workflow `params`, instantiate.
  //    `params` is exactly the `DispatchPayload` shape `RunWorkflow.run`
  //    decodes (apps/dispatcher/src/workflow.ts). `installation_id` (+
  //    `pr_number` when present) ride along in `github` for PR6.
  const executionId = ulid();
  const params = {
    executionId,
    run: body.run,
    github: {
      repo: body.github.repo,
      ref: body.github.ref,
      sha: body.github.sha,
      installation_id: body.github.installation_id,
      ...(body.github.pr_number !== undefined
        ? { pr_number: body.github.pr_number }
        : {}),
    },
    inputs,
  };

  await env.RUNS_WORKFLOW.create({ id: executionId, params });

  return json({ executionId }, 202);
};
