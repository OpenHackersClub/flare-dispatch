// Recipe: AI code review on AWS Bedrock via the BYOC `awsAssumeRole` trust path,
// routed through Cloudflare AI Gateway.
//
// Dispatcher-side run that:
//   1. Mints short-lived AWS credentials via OIDC federation (`awsAssumeRole`),
//      assuming the IAM role the caller passes as `roleArn`. The role's trust
//      policy pins the dispatcher's OIDC issuer URL + a `sub` claim pattern of
//      `multi-agent-review:*`, so a leaked HMAC alone can't assume it.
//   2. Clones the repo at `sha`, collects the diff vs `baseSha` (or `git log
//      --stat` when the base is omitted).
//   3. Calls Bedrock `InvokeModel` via the shared `invokeBedrockViaAiGateway`
//      helper — SigV4-signed against the AWS hostname, POSTed at the AI Gateway
//      forwarder URL. The gateway provides caching + observability + per-org
//      cost dashboards; the BYOC trust path stays intact (the gateway forwards
//      AWS creds in the SigV4 Authorization header, never holds them).
//   4. Posts the model's review back as a `flare-dispatch` PR review comment
//      via the `github.pullReview` capability when the dispatch carries
//      `pr` + `installationId`. The review text also lands in the run's
//      `summary_json` regardless.
//
// Why this run exists alongside `pr-review`:
//   - `pr-review`'s `bedrock` backend uses the same shared helper — the model
//     surface is unified. The two runs differ in dispatch shape: `pr-review`
//     reads model + region from CONFIG_KV (one operator setup, every call uses
//     the same model); `multi-agent-review` takes them per-dispatch (let a
//     workflow_dispatch override the model for QA / model-comparison work).
//   - The "multi-agent" name reflects the eventual fan-out to N domain
//     reviewers (security / performance / etc.) each calling the model with a
//     per-agent system prompt — same trust path, loop over agents. V0 is
//     single-agent because the load-bearing risk is the OIDC issuer → JWKS →
//     STS handshake, not the review quality.
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  multi-agent-review.prompt   (optional) override the system
//                                           prompt the model is invoked with.
//                                           Defaults to a generic "expert
//                                           software engineer reviewing a code
//                                           change" instruction. Project-
//                                           specific rubrics live in the
//                                           operator's own repo and get
//                                           published to KV via
//                                           `wrangler kv:key put ... --path`.
//
// --- Worker bindings (set in `wrangler.jsonc` or as Worker secrets) ---------
//
//   AI_GATEWAY_ID        Worker var (or secret) — the AI Gateway slug to route
//                        Bedrock through. Required: this run pins to the AI
//                        Gateway URL pattern (no direct AWS-hostname fallback).
//   CLOUDFLARE_ACCOUNT_ID  Worker var — the AI Gateway URL's first segment.
//   OIDC_SIGNING_JWK     ES256 private JWK the dispatcher signs JWTs with.
//   OIDC_ISSUER_URL      the dispatcher's origin (`https://<your-dispatcher>.workers.dev`).
//                        Must equal the OIDC provider URL registered in AWS IAM.
//   AI_GATEWAY_AUTH_TOKEN  (optional) — set ONLY when the gateway has
//                          [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
//                          turned on; the run forwards it as
//                          `cf-aig-authorization: Bearer <token>`.
//
// Spec: specs/05-byoc.md § AWS federation trust policy.

import { Effect, Schema } from "effect";
import {
  config,
  defineRun,
  github,
  io,
  modelGateway,
  sandbox,
  step,
  StepFailed,
} from "@flare-dispatch/core";
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

Output a concise, readable GitHub-flavoured markdown review:
- 1-2 sentence executive summary.
- A summary table of findings — one row each: | # | Severity | Finding | Location | (severity: critical/major/minor; order by severity).
- Then the details, grouped into AT MOST 8 actionable points ordered by severity. Merge related findings into one point rather than listing near-duplicates. Each point: what to change and why, in 1-3 sentences — direct, no filler.
- Link to code instead of quoting it. Render every location as a markdown link [path:line](https://github.com/{repo}/blob/{sha}/{path}#L{line}) using the repo and commit sha given in the request; do not paste code blocks or restate the diff.
- "LGTM" plus a one-line reason if no findings.`;

/** Footer marker on every PR comment this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: multi-agent-review -->";

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

      // 4. Bedrock InvokeModel via AI Gateway — `modelGateway.complete()`
      //    routes `bedrock/<modelId>` through the shared SigV4 + AI-Gateway
      //    forwarder. Threads the freshly-minted STS creds in via the `aws`
      //    field on the request; the modelGateway Bedrock route doesn't read
      //    creds from the runtime layer (they're per-execution, not deploy-
      //    time secrets).
      const modelId = input.modelId ?? DEFAULT_MODEL;
      const region = input.region ?? DEFAULT_REGION;

      const result = yield* step("invoke-bedrock", () =>
        modelGateway
          .complete({
            model: `bedrock/${modelId}`,
            system: systemPrompt,
            user: userPrompt,
            maxTokens: 4096,
            aws: {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              sessionToken: creds.sessionToken,
              region,
            },
          })
          .pipe(
            Effect.mapError(
              (e) =>
                new StepFailed({
                  step: "invoke-bedrock",
                  cause: e instanceof Error ? e.message : String(e),
                }),
            ),
          ),
      );

      const reviewBody = result.text.slice(0, 5000);
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
