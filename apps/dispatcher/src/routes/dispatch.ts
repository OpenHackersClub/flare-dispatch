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
import { fingerprint, SIGNATURE_HEADER, verify } from "../hmac";
import { lookupRun } from "../registry";

/** TTL on receiver-dedup KV entries — spec 04-gha § Receiver dedup (24h). */
const IDEMPOTENCY_TTL_SEC = 86_400;

/**
 * Build the semantic Workflow instanceId per spec 04-gha § Receiver dedup:
 * `{run}:{repo}:{sha[:12]}`, with `/` in the repo replaced with `_` so the
 * id is a single path segment. Two dispatches naming the same logical work
 * collapse onto one execution at the CF Workflows layer.
 *
 * SHA is truncated to 12 chars to keep the id well within CF Workflows'
 * 64-char instance-id limit; 12 hex chars is ~4.7e14 — collision space large
 * enough for a single repo's worth of unique commits.
 */
const semanticInstanceId = (run: string, repo: string, sha: string): string =>
  `${run}:${repo.replace(/\//g, "_")}:${sha.slice(0, 12)}`;

/** JSON helper — a `Response` with the right content-type. */
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The `github` context a dispatch carries — specs/04-gha-integration.md
 * § Dispatch body. `installation_id` is the GitHub App installation id PR6's
 * check-run callback needs to mint an installation token; it is **optional**
 * but, when present, MUST be a positive integer.
 *
 * The optionality matches the graceful-degradation contract in
 * `packages/runtime-cf/src/checks-github.ts` (`makeChecksGithubLive(undefined)`
 * returns a no-op `Checks` service): omitting `installation_id` means "do not
 * post a check-run — execute and record D1/R2 only". This is the right shape
 * for local dev, ad-hoc curl dispatches, and CI on repos where the App isn't
 * installed yet.
 *
 * `0` is explicitly rejected (a positive-integer refinement) because the
 * upstream JS Action defaults the `installation-id` input to `"0"` when unset,
 * which used to silently flow through to `getInstallationToken(0)` →
 * `Effect.orDie` (or worse, silently no-op when App secrets were absent),
 * leaving the PR with no `flare-dispatch/*` check-run even though the
 * dispatch step reported green. Rejecting 0 at the gate surfaces the
 * misconfig as a 400 the operator can see in the GHA log on the very first
 * run, instead of as a missing check-run discovered hours later.
 *
 * `pr_number` / `actor` are optional metadata that don't affect execution.
 */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, {
    default: () => "refs/heads/main",
  }),
  sha: Schema.String,
  pr_number: Schema.optional(Schema.Number),
  actor: Schema.optional(Schema.String),
  installation_id: Schema.optional(
    Schema.Number.pipe(
      Schema.positive({
        message: () =>
          'installation_id must be a positive GitHub App installation id (got 0). Either pass the `installation-id` action input — resolve via `gh api orgs/<org>/installations` — or omit the field entirely to dispatch without posting a check-run.',
      }),
    ),
  ),
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
  //
  // The 401 body carries `dispatcher_secret_fingerprint` — sha256(HMAC_SECRET)[:8]
  // — so an operator can match it against the caller-side fingerprint printed
  // by the GHA Action and pinpoint which side has the wrong value (issue #24).
  // Non-secret: 32 bits of pre-image after SHA-256 truncation is useless as a
  // credential, same shape as a git short-SHA.
  const signature = request.headers.get(SIGNATURE_HEADER);
  const signatureOk = await verify(env.HMAC_SECRET, signature, rawBody);
  if (!signatureOk) {
    return json(
      {
        error: "unauthorized",
        message: "HMAC signature missing or invalid",
        dispatcher_secret_fingerprint: await fingerprint(env.HMAC_SECRET),
      },
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

  // 6. Compute the dedup key + Workflow instanceId.
  //    Precedence: explicit `Idempotency-Key` header (direct callers MUST send
  //    one per spec 04-gha) → semantic `{run}:{repo}:{sha}` fallback. Both
  //    serve as BOTH the executionId returned to the caller AND the Workflow
  //    instanceId, so platform-level `create({id})` dedup is automatic.
  const headerKey = request.headers.get("Idempotency-Key");
  const executionId =
    headerKey && headerKey.length > 0
      ? headerKey
      : semanticInstanceId(body.run, body.github.repo, body.github.sha);

  // 7. Receiver-level dedup short-circuit. With IDEMPOTENCY_KV bound, a
  //    repeat delivery returns 202 immediately without touching Workflows.
  //    Without the KV, the duplicate-create catch in step 8 supplies the
  //    same end-state at the cost of one wasted Workflows RPC.
  if (env.IDEMPOTENCY_KV !== undefined) {
    const existing = await env.IDEMPOTENCY_KV.get(executionId);
    if (existing !== null) {
      return json({ executionId }, 202);
    }
  }

  // 8. Build the Workflow `params` — exactly the `DispatchPayload` shape
  //    `RunWorkflow.run` decodes (apps/dispatcher/src/workflow.ts).
  //    `installation_id` (+ `pr_number` when present) ride along in `github`.
  const params = {
    executionId,
    run: body.run,
    github: {
      repo: body.github.repo,
      ref: body.github.ref,
      sha: body.github.sha,
      ...(body.github.installation_id !== undefined
        ? { installation_id: body.github.installation_id }
        : {}),
      ...(body.github.pr_number !== undefined
        ? { pr_number: body.github.pr_number }
        : {}),
    },
    inputs,
  };

  // CF Workflows rejects a `create({id})` whose id has been seen before with
  // `instance.already_exists` — including ids whose instances have since been
  // terminated. The dispatcher's idempotency contract is "same {run, repo,
  // sha} → same execution", so a duplicate create on a known id is the
  // intended end-state and we swallow it. Any other failure must propagate.
  try {
    await env.RUNS_WORKFLOW.create({ id: executionId, params });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (!/already_exists/i.test(msg)) throw cause;
  }

  // 9. Record the dedup key AFTER the Workflow create succeeds — a failed
  //    create must remain retryable (the second attempt would otherwise be
  //    silently short-circuited above).
  if (env.IDEMPOTENCY_KV !== undefined) {
    await env.IDEMPOTENCY_KV.put(executionId, executionId, {
      expirationTtl: IDEMPOTENCY_TTL_SEC,
    });
  }

  return json({ executionId }, 202);
};
