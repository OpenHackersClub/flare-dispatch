#!/usr/bin/env bash
# Poll a dispatched `product-demo` execution to completion and surface its rrweb
# replay link (+ recorded artifacts) in the GHA logs and job summary.
#
# The on-PR product-demo reports its replay link + chapter markers on the
# `flare-dispatch/product-demo` check-run on the PR head. A `workflow_dispatch`
# run has no PR, so this prints the link directly instead.
#
# Required env (the dispatch Action's outputs):
#   ENDPOINT       Dispatcher base URL (vars.FLAREDISPATCH_ENDPOINT)
#   EXECUTION_ID   the action's `execution-id` output
#   LOGS_URL       the action's `logs-url` output (`…/logs/<id>?t=<token>`)
# Optional:
#   POLL_TIMEOUT   seconds to wait for completion (default 900)
set -euo pipefail

: "${ENDPOINT:?ENDPOINT is required}"
: "${EXECUTION_ID:?EXECUTION_ID is required}"
: "${LOGS_URL:?LOGS_URL is required}"
endpoint="${ENDPOINT%/}"
timeout="${POLL_TIMEOUT:-900}"

# The capability token rides on the tokened logs-url; the same token authorizes
# the executions detail endpoint.
token="${LOGS_URL##*t=}"
if [ -z "$LOGS_URL" ] || [ "$token" = "$LOGS_URL" ]; then
  echo "::warning::no tokened logs-url from the dispatch (deploy has no log-link secret) — cannot poll for the replay link."
  exit 0
fi

# Poll until the run reaches a terminal status (success | failure | cancelled).
detail=""
status=""
deadline=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  detail="$(curl -fsS "$endpoint/v1/executions/$EXECUTION_ID?t=$token" || true)"
  status="$(jq -r '.execution.status // empty' <<<"$detail")"
  case "$status" in
    success | failure | cancelled) break ;;
  esac
  sleep 10
done
echo "Final status: ${status:-timeout}"

# The docs-site player URL is only in `summary_json` (written on SUCCESS). The
# recorded replay/GIF/screenshots/summary are ALSO uploaded as artifacts,
# readable via the unguessable execution id regardless of run status — so a link
# is surfaced even when a story-acceptance nit marks the run `failure`.
player="$(jq -r '.summary.replayUri // empty' <<<"$detail")"
artifact="$(jq -r --arg ep "$endpoint" \
  '.artifacts[]? | select(.name | test("replay.*\\.json$")) | "\($ep)\(.url)"' <<<"$detail" | head -n 1)"
primary="${player:-$artifact}"

if [ -n "$primary" ]; then
  echo "::notice title=Product demo replay::$primary"
fi

{
  echo "### 🎬 Product demo — \`${status:-timeout}\`"
  echo ""
  echo "Execution: \`$EXECUTION_ID\`"
  echo ""
  if [ -n "$player" ]; then
    echo "**Replay (player):** $player"
    echo ""
  fi
  echo "**Recorded artifacts:**"
  jq -r --arg ep "$endpoint" \
    '.artifacts[]? | select(.name | test("replay.*\\.json$|\\.gif$|\\.png$|^summary\\.md$")) | "- [\(.name)](\($ep)\(.url))"' \
    <<<"$detail"
  if jq -e '.summary.stories | type == "array"' <<<"$detail" >/dev/null 2>&1; then
    echo ""
    echo "| Story | Chapter start (ms) | Chapter end (ms) | Per-story replay |"
    echo "| --- | --- | --- | --- |"
    jq -r '.summary.stories[]? | "| \(.story) | \(.chapterStartMs) | \(.chapterEndMs) | \(.replayUri) |"' <<<"$detail"
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$status" != "success" ]; then
  echo "::warning::product-demo run reported \`${status:-timeout}\` (e.g. a story-acceptance nit). The recorded replay/artifacts above are still available."
fi

# The job's purpose — surface the replay link — succeeds as long as we got a
# link (player URL or recorded artifact).
[ -n "$primary" ]
