#!/usr/bin/env bash
# Wire the `product-demo` log-viewer dogfood (product-demo-logviewer.yml) to
# drive FlareDispatch's OWN Cloudflare-Access-gated log viewer.
#
# The demo target (https://<dispatcher-host>/logs/<exec>?t=<token>) sits behind
# the "FlareDispatch viewer" Access app, so the demo agent's headless browser is
# 302'd to the SSO login unless it carries an Access identity. demo-agent already
# knows how to authenticate with a SERVICE TOKEN: given CF_ACCESS_CLIENT_ID /
# CF_ACCESS_CLIENT_SECRET it exchanges them for a CF_Authorization cookie scoped
# to the target host (packages/demo-agent/src/{cdp,access-scope}.ts). This script
# wires the resulting credentials + the demo URL so the run can authenticate.
#
# This script is the DETERMINISTIC, idempotent half: it writes the two service-
# token values into CONFIG_KV and sets the LOG_VIEWER_DEMO_URL repo var. Creating
# the service token + attaching a Service Auth policy to the Access app is a
# ONE-TIME step done out-of-band (it needs an Access-Admin-scoped API token the
# deploy token lacks). Do that first — either in the Zero Trust dashboard or with
# the curl commands documented under "ONE-TIME: service token + policy" below —
# then run this with the resulting client id/secret.
#
# Dry-run by default (prints intended mutations). Pass --apply to execute.
#
# ── Inputs (env vars) ───────────────────────────────────────────────────────
#   CF_ACCESS_CLIENT_ID      (required) the service token's Client ID
#   CF_ACCESS_CLIENT_SECRET  (required) the service token's Client Secret
#   LOG_VIEWER_DEMO_URL      (required) a tokened, RETAINED log URL to drive:
#                            https://<host>/logs/<exec>?t=<token>
#                            (copy one from the dashboard's "Open logs" link)
#   CLOUDFLARE_API_TOKEN     (required) used by `wrangler kv` — the deploy token
#                            is enough (it can read+write CONFIG_KV)
# ── Env overrides (sane defaults) ───────────────────────────────────────────
#   KV_BINDING  CONFIG_KV
#   STAGING_PREFIX  staging/      (where runs/product-demo.ts loads CF_ACCESS_*)
#   REPO  OpenHackersClub/flare-dispatch   (for the LOG_VIEWER_DEMO_URL var)
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
#   LOG_VIEWER_DEMO_URL='https://flare-dispatch-app.openhackers.club/logs/<exec>?t=<token>' \
#   scripts/setup-viewer-demo.sh            # dry run
#   …same env… scripts/setup-viewer-demo.sh --apply
#
# ── ONE-TIME: service token + Service Auth policy (out-of-band) ──────────────
# Dashboard: Zero Trust → Access → Service Auth → create a service token (copy
# the Client Secret — shown once); then the "FlareDispatch viewer" app → Policies
# → add a policy with Action = "Service Auth" that INCLUDES that token. A plain
# Allow policy will NOT accept a service token — it must be a Service Auth policy.
#
# Or via API (needs a token with Access: Service Tokens + Apps/Policies: Edit):
#   ACCT=<account-id>; AUD=798a196263789437498a9c113156cba102a3e1f6338ef95fc0ddcbd083643913
#   # 1. create the token (client_secret is returned ONLY here):
#   curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/access/service_tokens" \
#     -H "authorization: Bearer $CF_API_TOKEN_ZT" -H 'content-type: application/json' \
#     --data '{"name":"flare-dispatch viewer demo"}'
#   # 2. find the app id whose aud == $AUD:
#   curl -fsS "https://api.cloudflare.com/client/v4/accounts/$ACCT/access/apps" \
#     -H "authorization: Bearer $CF_API_TOKEN_ZT"
#   # 3. attach a Service Auth policy (token_id from step 1):
#   curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/access/apps/<app_id>/policies" \
#     -H "authorization: Bearer $CF_API_TOKEN_ZT" -H 'content-type: application/json' \
#     --data '{"name":"product-demo service token","decision":"non_identity","include":[{"service_token":{"token_id":"<token_id>"}}]}'
set -euo pipefail

KV_BINDING="${KV_BINDING:-CONFIG_KV}"
STAGING_PREFIX="${STAGING_PREFIX:-staging/}"
REPO="${REPO:-OpenHackersClub/flare-dispatch}"
APPLY="false"
[ "${1:-}" = "--apply" ] && APPLY="true"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

: "${CF_ACCESS_CLIENT_ID:?set CF_ACCESS_CLIENT_ID (the service token Client ID)}"
: "${CF_ACCESS_CLIENT_SECRET:?set CF_ACCESS_CLIENT_SECRET (the service token Client Secret)}"
: "${LOG_VIEWER_DEMO_URL:?set LOG_VIEWER_DEMO_URL (https://<host>/logs/<exec>?t=<token>)}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (deploy token can read+write CONFIG_KV)}"

# Validate the demo URL is a tokened /logs URL — a bare host or a missing ?t=
# would dispatch a run that can only ever render the "forbidden" gate.
if ! printf '%s' "$LOG_VIEWER_DEMO_URL" | grep -qE '^https://[^/]+/logs/[^?]+\?t=.+'; then
  red "✗ LOG_VIEWER_DEMO_URL is not a tokened log URL"
  red "  expected: https://<host>/logs/<exec>?t=<token>"
  red "  got:      $LOG_VIEWER_DEMO_URL"
  exit 1
fi

echo "==> repo=${REPO} kv=${KV_BINDING} prefix=${STAGING_PREFIX} apply=${APPLY}"
echo "    client_id=${CF_ACCESS_CLIENT_ID}"
echo "    demo_url=${LOG_VIEWER_DEMO_URL}"
echo

kv_put() { # kv_put KEY VALUE  — write to the remote CONFIG_KV namespace
  local key="$1" value="$2"
  if [ "$APPLY" = "true" ]; then
    npx wrangler kv key put --binding="$KV_BINDING" --remote "$key" "$value" >/dev/null
    green "  ✓ CONFIG_KV: $key"
  else
    blue "  → WOULD put CONFIG_KV: $key (dry-run)"
  fi
}

echo "[1/2] CONFIG_KV — service-token creds (loaded by runs/product-demo.ts under '${STAGING_PREFIX}')"
kv_put "${STAGING_PREFIX}CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_ID"
kv_put "${STAGING_PREFIX}CF_ACCESS_CLIENT_SECRET" "$CF_ACCESS_CLIENT_SECRET"

echo
echo "[2/2] repo variable — LOG_VIEWER_DEMO_URL (read by product-demo-logviewer.yml)"
if [ "$APPLY" = "true" ]; then
  gh variable set LOG_VIEWER_DEMO_URL --repo "$REPO" --body "$LOG_VIEWER_DEMO_URL"
  green "  ✓ repo var: LOG_VIEWER_DEMO_URL"
else
  blue "  → WOULD set repo var LOG_VIEWER_DEMO_URL (dry-run)"
fi

echo
cat <<EOF
==> done (${APPLY} mode).

Remaining prerequisites for the product-demo GIF to actually run — verify with
  scripts/check-product-demo-secrets.sh
These are general product-demo creds, independent of the Access service token:
  • Worker secrets : BROWSER_CDP_CONNECT_URL, BROWSER_CDP_API_TOKEN
  • CONFIG_KV      : product-demo.secret/CF_AI_GATEWAY_ID,
                     product-demo.secret/CLOUDFLARE_API_TOKEN,
                     product-demo.model.play, product-demo.model.summary

Smoke test once everything is set:
  gh workflow run product-demo-logviewer.yml         # uses vars.LOG_VIEWER_DEMO_URL
EOF
