#!/usr/bin/env bash
# FlareDispatch GHA Action — dispatch entry.
#
# Builds the dispatch body (specs/04-gha-integration.md § Dispatch body),
# HMAC-signs the EXACT bytes it POSTs (raw-bytes contract — apps/dispatcher/
# src/hmac.ts), and POSTs `${ENDPOINT}/v1/dispatch/${RUN}`. On HTTP 202 it
# parses `executionId` into $GITHUB_OUTPUT. Transient failures (unreachable /
# 429) retry up to 3x with backoff; 401/400/404 fail immediately (no retry).
#
# Inputs arrive as INPUT_* env vars (set by action.yml). V0 is fire-and-forget
# only — `await` mode is rejected by action.yml before this script runs.
set -euo pipefail

[ -n "${INPUT_RUN:-}" ]         || { echo "::error::'run' input is required"; exit 1; }
[ -n "${INPUT_ENDPOINT:-}" ]    || { echo "::error::'endpoint' input is required"; exit 1; }
[ -n "${INPUT_HMAC_SECRET:-}" ] || { echo "::error::'hmac-secret' input is required"; exit 1; }

RUN="${INPUT_RUN}"
ENDPOINT="${INPUT_ENDPOINT%/}"
INPUTS_JSON="${INPUT_INPUTS:-{\}}"
# installation_id: the GitHub App installation id for the target repo. The
# caller supplies it via the `installation-id` input; the App also auto-
# registers it from webhooks (specs/05-byoc.md § GitHub App setup), so a
# Dispatcher that has already seen this repo can resolve it server-side.
INSTALLATION_ID="${INPUT_INSTALLATION_ID:-0}"

# Build the dispatch body. `github.*` is sourced from GitHub Actions' GITHUB_*
# env vars; `trigger` carries the originating run/job for traceability.
BODY=$(RUN="$RUN" INPUTS_JSON="$INPUTS_JSON" INSTALLATION_ID="$INSTALLATION_ID" \
  node -e '
    const out = {
      run: process.env.RUN,
      github: {
        repo: process.env.GITHUB_REPOSITORY || "",
        ref: process.env.GITHUB_REF || "refs/heads/main",
        sha: process.env.GITHUB_SHA || "",
        actor: process.env.GITHUB_ACTOR || undefined,
        installation_id: Number(process.env.INSTALLATION_ID || 0),
      },
      inputs: JSON.parse(process.env.INPUTS_JSON || "{}"),
      trigger: {
        workflow_run_id: Number(process.env.GITHUB_RUN_ID || 0) || undefined,
        job_id: process.env.GITHUB_JOB || undefined,
      },
    };
    process.stdout.write(JSON.stringify(out));
  ')

# HMAC over the EXACT body bytes that get POSTed — sign and send the same
# `$BODY` value, no reformatting in between (raw-bytes contract).
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$INPUT_HMAC_SECRET" -binary | xxd -p -c 256)
URL="${ENDPOINT}/v1/dispatch/${RUN}"

attempt=0
while :; do
  attempt=$((attempt + 1))
  RESP=$(mktemp)
  # `--data-binary "$BODY"` sends the SAME bytes that were signed — no
  # reformatting between sign and send (raw-bytes contract). On a connection
  # failure curl exits non-zero and emits no http_code; normalize to "000".
  if CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
    -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "X-FlareDispatch-Signature: sha256=${SIG}" \
    --data-binary "$BODY"); then
    :
  else
    CODE="000"
  fi

  if [ "$CODE" = "202" ]; then
    EXEC_ID=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write((JSON.parse(s).executionId)||"")})' < "$RESP")
    echo "FlareDispatch: dispatched '${RUN}' — executionId=${EXEC_ID}"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "execution-id=${EXEC_ID}" >> "$GITHUB_OUTPUT"
    rm -f "$RESP"
    exit 0
  fi

  # 401 is almost always operator-config drift between this side's
  # FLAREDISPATCH_HMAC and the Worker's HMAC_SECRET. Compute the local
  # fingerprint (sha256(secret)[:8], lowercase hex) and print it next to the
  # dispatcher's fingerprint from the response body — if they differ, the side
  # with the unexpected value is the one to fix; if they match, the
  # canonicalization contract has drifted (file a separate bug). See
  # apps/dispatcher/src/hmac.ts § fingerprint and issue #24.
  if [ "$CODE" = "401" ]; then
    BODY=$(cat "$RESP")
    LOCAL_FP=$(printf '%s' "$INPUT_HMAC_SECRET" \
      | openssl dgst -sha256 -binary \
      | xxd -p -c 256 \
      | cut -c1-8)
    DISPATCHER_FP=$(printf '%s' "$BODY" \
      | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).dispatcher_secret_fingerprint||"<not provided>")}catch{process.stdout.write("<not provided>")}})')
    echo "::error::FlareDispatch dispatch failed (HTTP 401): ${BODY}"
    echo "::error::HMAC drift between flare-dispatch-action and Dispatcher Worker."
    echo "  local secret fingerprint      = ${LOCAL_FP}"
    echo "  dispatcher secret fingerprint = ${DISPATCHER_FP}"
    echo "  → if they differ, re-sync the secret on the mismatching side"
    echo "  → if they match, the canonicalization contract has drifted (file a separate bug)"
    rm -f "$RESP"
    exit 1
  fi

  # 400/404 are config bugs — fail immediately, no retry.
  case "$CODE" in
    400|404)
      echo "::error::FlareDispatch dispatch failed (HTTP ${CODE}): $(cat "$RESP")"
      rm -f "$RESP"
      exit 1
      ;;
  esac

  # Transient (unreachable / 429 / 5xx) — retry up to 3x with backoff.
  if [ "$attempt" -ge 3 ]; then
    echo "::error::FlareDispatch dispatch failed after ${attempt} attempts (HTTP ${CODE}): $(cat "$RESP")"
    rm -f "$RESP"
    exit 1
  fi
  echo "FlareDispatch: transient failure (HTTP ${CODE}), retry ${attempt}/3..."
  rm -f "$RESP"
  sleep "$((attempt * 5))"
done
