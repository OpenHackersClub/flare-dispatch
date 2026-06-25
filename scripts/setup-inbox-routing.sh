#!/usr/bin/env bash
# Automate the one-time Email Routing wiring for the `mailbox` capability
# (recipes/email-otp-login). Idempotent: safe to re-run.
#
# Steps it performs (all via the Cloudflare API):
#   2. Enable Email Routing on the zone (adds the managed MX/SPF records).
#   3. Point the CATCH-ALL rule at the dispatcher Worker, so every address on
#      the email host is delivered to the Worker's email() handler.
#   4. Print the exact follow-up to flip INBOX_DOMAIN (a wrangler.jsonc var) +
#      redeploy — that part is a code change, not an API call.
#
# Dry-run by default (prints intended mutations). Pass --apply to execute.
#
# REQUIRED token scope (the deploy token is NOT enough — it lacks these):
#   Zone : Email Routing Rules : Edit   (on the zone below)
#   Zone : Email Routing Addresses : Edit
#   Zone : DNS : Edit                    (Email Routing manages MX/SPF)
#   Zone : Zone : Read
# Mint one at https://dash.cloudflare.com/profile/api-tokens and export it as
# CLOUDFLARE_API_TOKEN before running.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... scripts/setup-inbox-routing.sh             # dry run
#   CLOUDFLARE_API_TOKEN=... scripts/setup-inbox-routing.sh --apply
#
# Env overrides:
#   ZONE        apex zone (default: openhackers.club)
#   INBOX_HOST  the email host inboxes live on (default: inbox.openhackers.club)
#   WORKER      the dispatcher Worker name (default: flare-dispatch-v0)
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
ZONE="${ZONE:-openhackers.club}"
INBOX_HOST="${INBOX_HOST:-inbox.openhackers.club}"
WORKER="${WORKER:-flare-dispatch-v0}"
APPLY="false"
[ "${1:-}" = "--apply" ] && APPLY="true"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (see header for required scopes)}"

cf() { # cf METHOD PATH [JSON_BODY] — returns the raw response body
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "${API}${path}" \
      -H "authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "content-type: application/json" --data "$body"
  else
    curl -fsS -X "$method" "${API}${path}" \
      -H "authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
  fi
}

jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(eval("d"+sys.argv[1]))' "$1"; }

echo "==> zone=${ZONE} inbox_host=${INBOX_HOST} worker=${WORKER} apply=${APPLY}"

# --- resolve zone id -------------------------------------------------------
ZID="$(cf GET "/zones?name=${ZONE}" | jget '["result"][0]["id"]')"
[ -n "$ZID" ] || { echo "!! zone ${ZONE} not found / token can't read zones"; exit 1; }
echo "==> zone id resolved"

# --- guard: a catch-all on the APEX swallows ALL mail to the zone ----------
if [ "$INBOX_HOST" = "$ZONE" ]; then
  echo "!! INBOX_HOST is the zone apex — a catch-all → Worker there intercepts"
  echo "   EVERY address on ${ZONE} (the handler bounces non-demo RCPTs). Use a"
  echo "   DEDICATED subdomain (the default inbox.${ZONE}) to keep the blast radius"
  echo "   small. Re-run with INBOX_HOST=inbox.${ZONE}. Refusing apex." ; exit 1
fi

# --- step 2: enable Email Routing -----------------------------------------
ENABLED="$(cf GET "/zones/${ZID}/email/routing" | jget '["result"]["enabled"]' 2>/dev/null || echo "ERR")"
if [ "$ENABLED" = "ERR" ]; then
  echo "!! cannot read Email Routing on this zone — token is missing the"
  echo "   'Email Routing' permission (see header). Nothing was changed."; exit 1
fi
if [ "$ENABLED" = "True" ]; then
  echo "==> [2] Email Routing already enabled"
elif [ "$APPLY" = "true" ]; then
  cf POST "/zones/${ZID}/email/routing/enable" '{}' >/dev/null
  echo "==> [2] Email Routing enabled"
else
  echo "==> [2] WOULD enable Email Routing (dry-run)"
fi

echo "    NOTE: receiving at ${INBOX_HOST} needs its MX records pointing at"
echo "    Cloudflare's email servers. Email Routing manages the apex MX; for a"
echo "    subdomain, add it under Email → Settings → Custom subdomains (or the"
echo "    API equivalent) so its MX are provisioned. Verify with:"
echo "      dig +short MX ${INBOX_HOST}"

# --- step 3: catch-all → worker -------------------------------------------
RULE_BODY="$(printf '{"name":"flare-dispatch mailbox catch-all","enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["%s"]}]}' "$WORKER")"
if [ "$APPLY" = "true" ]; then
  cf PUT "/zones/${ZID}/email/routing/rules/catch_all" "$RULE_BODY" >/dev/null
  echo "==> [3] catch-all rule set → Worker '${WORKER}'"
else
  echo "==> [3] WOULD set catch-all → Worker '${WORKER}' (dry-run):"
  echo "    $RULE_BODY"
fi

# --- step 4: the code-side flip (not an API call) -------------------------
cat <<EOF

==> [4] FINAL STEP (code, do after the above succeeds + MX verify):
    Uncomment in wrangler.jsonc 'vars':
        "INBOX_DOMAIN": "${INBOX_HOST}",
    optionally "INBOX_ALLOWED_SENDERS": "auth0.com,clerk.com,...",
    then redeploy:  wrangler deploy   (or merge to main → CI deploys).
    Until INBOX_DOMAIN is set, the mailbox capability stays a dying stub.

==> done (${APPLY} mode). Smoke test once live:
      gh workflow run email-otp-login -f base_url=https://<your-otp-target>
EOF
