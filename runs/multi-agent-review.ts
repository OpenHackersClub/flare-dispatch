// Recipe: AI code review on AWS Bedrock via the BYOC `awsAssumeRole` trust path.
//
// Dispatcher-side run that:
//   1. Mints short-lived AWS credentials via OIDC federation (`awsAssumeRole`),
//      assuming the IAM role the caller passes as `roleArn`. The role's trust
//      policy pins the dispatcher's OIDC issuer URL + a `sub` claim pattern of
//      `multi-agent-review:*`, so a leaked HMAC alone can't assume it.
//   2. Clones the repo at `sha`, collects the diff vs `baseSha` (or `git log
//      --stat` when the base is omitted).
//   3. Calls Bedrock `InvokeModel` directly via SigV4 (no SDK; ~120 lines using
//      SubtleCrypto). Default model is `us.anthropic.claude-opus-4-6-v1`; the
//      caller can override per-dispatch via `modelId`.
//   4. Posts the model's review back as a `flare-dispatch` PR review comment
//      via the `github.pullReview` capability when the dispatch carries
//      `pr` + `installationId`. The review text also lands in the run's
//      `summary_json` regardless.
//
// Why this run exists alongside `pr-review`:
//   - `pr-review` calls Workers AI via the `modelGateway` capability — no
//     model API key, but limited to the binding's model catalog (Llama family
//     by default; an AI Gateway extends to Anthropic-via-compat).
//   - `multi-agent-review` calls Bedrock directly via federated AWS creds — no
//     model API key either, but the operator picks any Bedrock-enabled model
//     in their account (Anthropic Opus, Llama, Mistral, etc.) and pays per-
//     invoke through their AWS bill rather than CF Workers AI.
//
// The two runs share the recipe shape (defineRun + post-comment + idempotent
// marker) so an operator can pick one or run both — see the recipe README for
// when each backend wins.
//
// V0 shape (this file): single-agent reviewer. The "multi-agent" name reflects
// the eventual fan-out to N domain reviewers (security / performance / etc.)
// each calling the model with a per-agent system prompt — same trust path,
// loop over agents. Land that as a follow-up; the load-bearing risk in V0 is
// the OIDC issuer → JWKS → STS handshake, not the review quality.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  multi-agent-review.prompt   (optional) override the system prompt
//                                           the model is invoked with. Defaults
//                                           to a generic "expert software
//                                           engineer reviewing a code change"
//                                           instruction. Project-specific
//                                           rubrics (Effect-TS / hexagonal /
//                                           etc.) live in the operator's own
//                                           repo and get published to KV via
//                                           `wrangler kv:key put ... --path`.
//
// --- Worker Secrets (`wrangler secret put`) ---------------------------------
//
//   OIDC_SIGNING_JWK   ES256 private JWK the dispatcher signs JWTs with;
//                      AWS validates against the JWKS at `<issuer>/.well-known/jwks.json`.
//   OIDC_ISSUER_URL    the dispatcher's origin (`https://<your-dispatcher>.workers.dev`).
//                      Must equal the OIDC provider URL registered in AWS IAM.
//
// Spec: specs/05-byoc.md § AWS federation trust policy.

import { Effect, Schema } from "effect";
import { config, defineRun, github, io, sandbox, step, StepFailed } from "@flare-dispatch/core";
import { awsAssumeRole } from "@flare-dispatch/core/primitives";

const Input = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  /** Diff base — the merge-base, or omit for a `git log --stat` summary. */
  baseSha: Schema.optional(Schema.String),
  /** Optional focus area to feed the system prompt (workflow_dispatch input). */
  focusArea: Schema.optional(Schema.String),
  /** Override the default Bedrock model id. */
  modelId: Schema.optional(Schema.String),
  /** Bedrock region. Defaults to us-east-1; STS exchange happens in this region. */
  region: Schema.optional(Schema.String),
  /**
   * IAM role ARN to AssumeRoleWithWebIdentity into. Required — passed by the
   * dispatch caller (typically a GHA workflow secret like
   * `secrets.FLAREDISPATCH_BEDROCK_ROLE_ARN`).
   */
  roleArn: Schema.String,
  /**
   * PR number. When set with `installationId`, the run posts the Bedrock
   * review back as a `flare-dispatch` PR review comment. Omit (e.g.
   * workflow_dispatch / branch-level run) to skip the comment-post step
   * — the review still lands in the check-run summary + `summary_json`.
   */
  pr: Schema.optional(Schema.Number),
  /**
   * GitHub App installation id for the comment-post path. Webhook mode maps
   * it from `payload.installation.id`; Action mode passes it via the action's
   * `installation-id` input (which the dispatcher route puts on
   * `payload.github.installation_id` and the workflow threads through to
   * runs). Omit to skip the comment-post.
   */
  installationId: Schema.optional(Schema.Number),
});

const Output = Schema.Struct({
  /** First 5000 chars of the model's response (full text in R2 logs). */
  review: Schema.String,
  /** Model id actually invoked. */
  modelId: Schema.String,
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
});

// Inference profile id (no `:N` version suffix). Anthropic Claude Opus 4.6 is
// the default because it's the strongest reviewer on Bedrock today; operators
// override per-dispatch via `input.modelId` if they want a cheaper tier.
const DEFAULT_MODEL = "us.anthropic.claude-opus-4-6-v1";
const DEFAULT_REGION = "us-east-1";

// Cap diff payload so it fits in Claude Opus's context with room for the
// system prompt + response.
const MAX_DIFF_CHARS = 100_000;

/** Generic per-domain reviewer instruction. Operators override via the
 *  `multi-agent-review.prompt` CONFIG_KV key with their own project-tailored
 *  rubric (severity calibration, "what NOT to flag", project conventions). */
const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer reviewing a code change.

Review the diff for: correctness bugs, missing error handling, security issues, missing tests, and design / architecture concerns specific to the languages and frameworks the diff touches.

Output a markdown review with:
- 2-sentence executive summary
- Findings as a bulleted list, each with: file:line (if locatable), 1-line description, severity (critical/major/minor)
- "LGTM" if no findings`;

/** Footer marker on every PR comment this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: multi-agent-review -->";

// --- AWS SigV4 + Bedrock InvokeModel (no SDK; ~120 lines using SubtleCrypto) -

async function invokeBedrock(opts: {
  creds: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
  };
  region: string;
  modelId: string;
  body: unknown;
}): Promise<{ response: string; inputTokens?: number; outputTokens?: number }> {
  const host = `bedrock-runtime.${opts.region}.amazonaws.com`;
  // SigV4 canonical URI requires path segments to be URL-encoded TWICE
  // (RFC 3986 path encoding, then again for the canonical request). For an
  // inference-profile id like `us.anthropic.claude-opus-4-6-v1`, the encoding
  // is a no-op; for ids containing `:` (older versioned ARNs), the colon goes
  // `:` → `%3A` (request URL) → `%253A` (canonical URI in the signature).
  const urlPath = `/model/${encodeURIComponent(opts.modelId)}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(encodeURIComponent(opts.modelId))}/invoke`;
  const payload = JSON.stringify(opts.body);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const service = "bedrock";
  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;

  const payloadHash = await sha256Hex(payload);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${opts.creds.sessionToken}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

  const canonicalRequest =
    `POST\n${canonicalPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const signingKey = await deriveSigningKey(
    opts.creds.secretAccessKey,
    dateStamp,
    opts.region,
    service,
  );
  const signature = await hmacHex(signingKey, stringToSign);

  const authorization =
    `${algorithm} Credential=${opts.creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${urlPath}`, {
    method: "POST",
    headers: {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "x-amz-security-token": opts.creds.sessionToken,
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`bedrock-invoke-failed status=${res.status} body=${text.slice(0, 1000)}`);
    throw new Error(
      `Bedrock InvokeModel failed: HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }
  console.log(`bedrock-invoke-ok status=${res.status}`);

  // Anthropic-on-Bedrock body shape:
  //   { content: [{type:"text", text:"..."}],
  //     usage: { input_tokens, output_tokens }, ... }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const response = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");

  const result: { response: string; inputTokens?: number; outputTokens?: number } = {
    response,
  };
  if (json.usage?.input_tokens !== undefined) {
    result.inputTokens = json.usage.input_tokens;
  }
  if (json.usage?.output_tokens !== undefined) {
    result.outputTokens = json.usage.output_tokens;
  }
  return result;
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

async function hmacHex(key: ArrayBuffer, msg: string): Promise<string> {
  const buf = await hmac(key, msg);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// ---------------------------------------------------------------------------

export const multiAgentReview = defineRun({
  name: "multi-agent-review",
  version: "0.1.0",

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1500 },

  run: (input) =>
    Effect.gen(function* () {
      // 1. Mint AWS credentials via OIDC federation. The OIDC `sub` claim is
      //    `<run>:<execution-id>` (set by the dispatcher); the role's trust
      //    policy SHOULD pin `sub: multi-agent-review:*` so a leaked HMAC
      //    alone can't assume the role.
      const creds = yield* step("assume-bedrock-role", () =>
        awsAssumeRole({
          roleArn: input.roleArn,
          region: input.region ?? DEFAULT_REGION,
          sessionName: `multi-agent-review-${input.sha.slice(0, 12)}`,
        }),
      );

      // 2. Check out the repo + collect the diff (or recent log when no base).
      const repoDir = yield* step("checkout", () =>
        sandbox.git.clone({ repo: input.repo, sha: input.sha }),
      );

      const diffCommand = input.baseSha
        ? `git diff --unified=3 ${input.baseSha} ${input.sha}`
        : `git log --stat -n 50 ${input.sha}`;

      const diffResult = yield* step("collect-diff", () =>
        sandbox.exec({ cwd: repoDir, command: diffCommand, timeoutSec: 60 }),
      );

      const diffText = (diffResult.stdout ?? "").slice(0, MAX_DIFF_CHARS);
      const focusLine = input.focusArea
        ? `\nFocus area for this review: ${input.focusArea}\n`
        : "";
      const userPrompt =
        `Review the following git output for repo ${input.repo} at ${input.sha}.${focusLine}\n` +
        `<git-output>\n${diffText}\n</git-output>`;

      // 3. Resolve the system prompt — operator override or the engine's
      //    generic default. Operators publish their project-tailored rubric to
      //    `multi-agent-review.prompt` via `wrangler kv:key put`. A missing
      //    key falls back to `DEFAULT_SYSTEM_PROMPT` so a fresh deploy has a
      //    working reviewer out of the box.
      const promptOverride = yield* step("resolve-prompt", () =>
        config.get("multi-agent-review.prompt"),
      );
      const systemPrompt = promptOverride ?? DEFAULT_SYSTEM_PROMPT;

      // 4. Bedrock InvokeModel. SigV4 + STS session token. Anthropic-on-Bedrock
      //    body format.
      const modelId = input.modelId ?? DEFAULT_MODEL;
      const region = input.region ?? DEFAULT_REGION;

      const result = yield* step("invoke-bedrock", () =>
        Effect.tryPromise({
          try: () =>
            invokeBedrock({
              creds: {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
              },
              region,
              modelId,
              body: {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
              },
            }),
          catch: (cause) =>
            new StepFailed({
              step: "invoke-bedrock",
              cause: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      );

      const reviewBody = result.response.slice(0, 5000);
      const out: {
        review: string;
        modelId: string;
        inputTokens?: number;
        outputTokens?: number;
      } = {
        review: reviewBody,
        modelId,
      };
      if (result.inputTokens !== undefined) out.inputTokens = result.inputTokens;
      if (result.outputTokens !== undefined) out.outputTokens = result.outputTokens;

      // 5. Post the Bedrock review back as a PR review comment when both
      //    `pr` and `installationId` are present (Action mode wires both
      //    via the GHA workflow's `installation-id` input + `pr` field).
      //    Best-effort: a 4xx/5xx from GitHub doesn't fail the run — the
      //    review still lives in the check-run summary + summary_json. The
      //    comment carries a marker footer so a follow-up push idempotently
      //    updates the same review thread.
      if (input.pr !== undefined && input.installationId !== undefined) {
        const commentBody = renderReviewComment(
          modelId,
          reviewBody,
          result.inputTokens,
          result.outputTokens,
        );
        yield* step("post-comment", () =>
          github
            .pullReview({
              repo: input.repo,
              pr: input.pr as number,
              sha: input.sha,
              body: commentBody,
              installationId: input.installationId as number,
            })
            .pipe(
              Effect.catchAll((e) =>
                io.log(
                  "warn",
                  `multi-agent-review: PR comment post failed — ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                ),
              ),
            ),
        );
      }

      return out;
    }),
});

/** Render the Bedrock review as a PR review comment. The model's text is
 *  treated as already-formatted markdown (the system prompt asks for
 *  GitHub-flavoured markdown) — no transformation beyond a header line + a
 *  token-count footer. */
const renderReviewComment = (
  modelId: string,
  review: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): string => {
  const tokenLine =
    inputTokens !== undefined && outputTokens !== undefined
      ? `\n\n<sub>model: \`${modelId}\` · ${inputTokens} in / ${outputTokens} out</sub>`
      : `\n\n<sub>model: \`${modelId}\`</sub>`;
  return `### AI code review — multi-agent (Bedrock)\n\n${review}${tokenLine}\n\n${COMMENT_MARKER}\n`;
};
