#!/usr/bin/env bash
# Verify every Worker Secret + CONFIG_KV entry the `product-demo` run needs.
#
# Touch points
#   * Worker Secrets — the live `browser` Layer reads these from `env`.
#     Set with `wrangler secret put <NAME>`.
#       - BROWSER_CDP_CONNECT_URL   — Browser Rendering CDP WS endpoint
#       - BROWSER_CDP_API_TOKEN     — token auth for the CDP connect
#   * CONFIG_KV entries — `loadSecrets` resolves these into the env record
#     handed to `sandbox.exec`. Set with `wrangler kv key put --binding=CONFIG_KV`.
#     The agent is provider-agnostic on `@effect/ai`'s LanguageModel Tag over
#     the OpenAI wire protocol; the choice of provider lives in MODEL_BASE_URL.
#     Three required + one optional, all namespaced under `product-demo.secret/`:
#       Required
#       - product-demo.secret/MODEL_BASE_URL         (OpenAI-compatible endpoint —
#                                                    AI Gateway `/v1/<acct>/<id>/compat`
#                                                    is the recommended default)
#       - product-demo.secret/CLOUDFLARE_ACCOUNT_ID
#       - product-demo.secret/CLOUDFLARE_API_TOKEN
#       Optional
#       - product-demo.secret/MODEL_API_KEY          (only when the chosen endpoint
#                                                    needs a direct credential; with
#                                                    AI Gateway BYOK this stays unset)
#
# Usage
#   ./scripts/check-product-demo-secrets.sh                 # check default env
#   ./scripts/check-product-demo-secrets.sh --env staging   # named CF env

set -euo pipefail

ENV_ARGS=()
if [[ "${1:-}" == "--env" && -n "${2:-}" ]]; then
  ENV_ARGS=("--env" "$2")
fi

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

missing=0
note()   { yellow "  → $*"; }
fail()   { red "  ✗ $*"; missing=$((missing + 1)); }
ok()     { green "  ✓ $*"; }

require_secret() {
  local name=$1
  if wrangler secret list "${ENV_ARGS[@]}" 2>/dev/null | grep -q "\"name\": \"$name\""; then
    ok "$name"
  else
    fail "$name not set — run: wrangler secret put $name ${ENV_ARGS[*]}"
  fi
}

require_kv_key() {
  local key=$1
  if wrangler kv key get --binding=CONFIG_KV "$key" "${ENV_ARGS[@]}" >/dev/null 2>&1; then
    ok "CONFIG_KV: $key"
  else
    fail "CONFIG_KV missing key '$key' — run: wrangler kv key put --binding=CONFIG_KV ${ENV_ARGS[*]} '$key' <value>"
  fi
}

optional_kv_key() {
  local key=$1
  if wrangler kv key get --binding=CONFIG_KV "$key" "${ENV_ARGS[@]}" >/dev/null 2>&1; then
    ok "CONFIG_KV: $key (optional, present)"
  else
    note "CONFIG_KV: $key (optional, unset — only required if your AI Gateway has Authenticated Gateway on)"
  fi
}

echo "Worker Secrets"
require_secret BROWSER_CDP_CONNECT_URL
require_secret BROWSER_CDP_API_TOKEN

echo
echo "CONFIG_KV entries (product-demo.secret/, required)"
require_kv_key product-demo.secret/MODEL_BASE_URL
require_kv_key product-demo.secret/CLOUDFLARE_ACCOUNT_ID
require_kv_key product-demo.secret/CLOUDFLARE_API_TOKEN

echo
echo "CONFIG_KV entries (product-demo.secret/, optional)"
optional_kv_key product-demo.secret/MODEL_API_KEY

echo
if [[ $missing -eq 0 ]]; then
  green "All required product-demo secrets present."
else
  red "$missing missing — set the values above before dispatching product-demo."
  note "After setting, re-run this script to confirm."
  exit 1
fi
