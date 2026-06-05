# Recipe: AI code review on AWS Bedrock (BYOC trust path)

Sibling to [`ai-code-review`](../ai-code-review/) — same surface (PR review comment + check-run), different model backend. Where `pr-review` calls Workers AI via the `modelGateway` capability, **`multi-agent-review` calls AWS Bedrock directly** via the `awsAssumeRole` primitive: the dispatcher signs an OIDC JWT, AWS STS exchanges it for short-lived credentials, the run signs `bedrock:InvokeModel` with SigV4. **No model API key. No long-lived AWS access key.** The auth flow is the operator's own OIDC issuer + an IAM role's trust policy, both BYOC.

## Why this exists alongside `pr-review`

| | `pr-review` | `multi-agent-review` |
|---|---|---|
| Model surface | Workers AI binding (`env.AI`) | AWS Bedrock `InvokeModel` |
| Model catalog | Workers AI's hosted set, plus Anthropic-via-compat through an AI Gateway | every Bedrock-enabled model in your AWS account (Anthropic Opus, Llama, Mistral, Titan, …) |
| Auth | the binding is the auth (no key) | OIDC federation → IAM role assume (no key) |
| Bill | CF Workers AI quota | your AWS bill |
| Best for | every-PR cheap reviewer | tier-1 model on PRs you want depth on, or running both in parallel |

Pick one based on the model you want; run both side-by-side if you want a redundant reviewer panel (the `flare-dispatch/pr-review` and `flare-dispatch/multi-agent-review` check-runs each post their own review comment, gated by their own marker, with their own idempotency).

## How the BYOC trust path works

```mermaid
flowchart LR
  W[FlareDispatch Worker] -->|"oidc.sign({ aud: sts.amazonaws.com })"| JWT[Signed JWT<br/>iss = OIDC_ISSUER_URL<br/>sub = multi-agent-review:&lt;exec&gt;]
  JWT -->|AssumeRoleWithWebIdentity| STS[AWS STS]
  STS -->|"verify iss against<br/>AWS OIDC provider"| OP[OIDC Provider<br/>arn:aws:iam::&lt;acct&gt;:oidc-provider/&lt;host&gt;]
  STS -->|short-lived creds<br/>access + secret + session| W
  W -->|"SigV4-signed POST<br/>bedrock-runtime:InvokeModel"| BR[Bedrock]
```

The dispatcher publishes its OIDC discovery + JWKS at `/.well-known/openid-configuration` and `/.well-known/jwks.json`. AWS validates the JWT's `iss` against the OIDC provider URL the operator registered, and validates the `sub` against the IAM role's trust policy. Two factors gate the role assumption — the HMAC + the JWT signature — so a leaked HMAC alone cannot mint Bedrock-invoke credentials.

## Setup

### 1. Register the dispatcher as an OIDC provider in AWS

```sh
aws iam create-open-id-connect-provider \
  --url "https://<your-dispatcher>.workers.dev" \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list <sha1-of-jwks-tls-leaf-cert>
```

The `url` MUST equal the `OIDC_ISSUER_URL` Worker secret (issuer URL is checked exactly). If the URL ever changes, the OIDC provider has to be re-created (AWS doesn't allow updating it).

### 2. Create the IAM role + Bedrock-invoke policy

```json5
// Trust policy — pinned to ONE run + a Federated principal.
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::<acct>:oidc-provider/<your-dispatcher>.workers.dev"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "<your-dispatcher>.workers.dev:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "<your-dispatcher>.workers.dev:sub": "multi-agent-review:*"
      }
    }
  }]
}
```

```json5
// Policy — narrow to the model(s) you actually invoke. Anthropic Claude Opus
// 4.6's inference profile is the default the run uses.
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "bedrock:InvokeModel",
    "Resource": [
      "arn:aws:bedrock:us-*:<acct>:inference-profile/us.anthropic.claude-opus-4-6-v1",
      "arn:aws:bedrock:us-*::foundation-model/anthropic.claude-opus-4-6-v1:0"
    ]
  }]
}
```

### 3. Worker Secrets

Set on the Dispatcher Worker via `wrangler secret put`:

| Secret | What it is |
|---|---|
| `OIDC_SIGNING_JWK` | ES256 private JWK the Dispatcher signs JWTs with. Generate with `pnpm cli oidc keygen`. |
| `OIDC_ISSUER_URL` | The Dispatcher's origin (`https://<your-dispatcher>.workers.dev`). Must equal the `url` of the AWS OIDC provider (step 1). |

The matching public JWK is auto-served at `<issuer>/.well-known/jwks.json`; AWS pulls it on the first STS exchange and caches by `kid`.

### 4. (Optional) Override the system prompt

The default prompt is generic ("expert software engineer reviewing a code change"). For project-specific guardrails (architecture conventions, severity calibration, "what NOT to flag" lists), override via CONFIG_KV:

```sh
wrangler kv:key put \
  --binding=CONFIG_KV \
  multi-agent-review.prompt \
  --path .your-repo/path/to/review-rubric.md
```

Re-run the command after editing the rubric — the file is the source of truth, KV is its mirror.

### 5. Dispatch from GHA (Action mode)

Drop this into `.github/workflows/multi-agent-review.yml`:

```yaml
name: multi-agent-review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore:
      - "*.md"

permissions:
  contents: read
  checks: write
  pull-requests: read

jobs:
  dispatch:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: OpenHackersClub/flare-dispatch/actions/flare-dispatch-action@<sha>
        with:
          run: multi-agent-review
          endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
          hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
          installation-id: ${{ vars.FLAREDISPATCH_INSTALLATION_ID }}
          inputs: |
            {
              "repo": "${{ github.repository }}",
              "sha": "${{ github.event.pull_request.head.sha }}",
              "baseSha": "${{ github.event.pull_request.base.sha }}",
              "roleArn": "${{ secrets.FLAREDISPATCH_BEDROCK_ROLE_ARN }}",
              "pr": ${{ github.event.pull_request.number }},
              "installationId": ${{ vars.FLAREDISPATCH_INSTALLATION_ID && fromJSON(vars.FLAREDISPATCH_INSTALLATION_ID) || 'null' }}
            }
```

The `installationId` expression handles the unset-var case (renders as `null`, which the schema treats as omitted optional). Pin the action SHA from upstream `main`.

## Inputs

| Field | Required | Default | Notes |
|---|---|---|---|
| `repo` | yes | — | `owner/name` |
| `sha` | yes | — | head SHA to review |
| `baseSha` | no | — | merge-base or omit for `git log --stat -n 50` |
| `roleArn` | yes | — | IAM role to AssumeRoleWithWebIdentity into |
| `modelId` | no | `us.anthropic.claude-opus-4-6-v1` | any Bedrock-enabled model id in your account |
| `region` | no | `us-east-1` | STS + Bedrock region |
| `focusArea` | no | — | extra context line appended to the user prompt |
| `pr` | no | — | PR number; required for the comment-post path |
| `installationId` | no | — | App installation id; required for the comment-post path |

## Outputs

A `{ review, modelId, inputTokens?, outputTokens? }` object — `review` is the first 5000 chars of the model's text (the full body lives in R2 logs at the run's artifact path). The same review text lands as a `flare-dispatch` PR review comment when `pr` + `installationId` are present.

## Flow

```mermaid
flowchart LR
  D[Dispatch] --> AS[assume-bedrock-role<br/>OIDC → STS]
  AS --> CO[checkout]
  CO --> CD[collect-diff]
  CD --> RP[resolve-prompt<br/>CONFIG_KV override]
  RP --> IB[invoke-bedrock<br/>SigV4 + InvokeModel]
  IB --> PC[post-comment<br/>github.pullReview]
  PC --> CHK[check-run<br/>summary + summary_json]
```

## Why a separate run from `pr-review`

The two reviewers share the recipe shape (defineRun + post-comment + idempotent marker) so the choice is binary at the workflow level: dispatch `pr-review` or `multi-agent-review` (or both, in parallel — they hold separate concurrency groups, separate markers, separate check-runs). One run per PR per backend keeps the comment surface deduplicated and lets operators turn either off independently.

The "multi-agent" name reflects the eventual fan-out to N domain reviewers (security / performance / code-quality / etc.) each calling the model with a per-agent system prompt — same trust path, loop over agents. V0 is single-agent; the load-bearing risk is the OIDC issuer → JWKS → STS handshake, not the review quality.
