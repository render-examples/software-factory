#!/usr/bin/env bash
# Characterization / parity-oracle spike — native runtime (render-agents engine +
# `workspace` tools). Boots the demo gateway with the in-memory store and dispatches
# `characterize`, which clones sindresorhus/leven, generates __characterization__.test.mjs
# via the `characterizer` agent, and certifies it (determinism + mutation battery).
# Requires an LLM provider key; no opencode / no extra binaries.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: spike-characterize.sh [options]

Options:
  -h, --help        Show this help and exit
  --skip-build      Skip `pnpm install && pnpm build` at the repo root
  --no-start        Don't start the gateway (assume one is already up on PORT)

Environment (defaults shown):
  PORT=3015                        Gateway listen port
  RENDER_AGENTS_API_KEY=dev-key    Bearer token for gateway auth
  RENDER_WORKSPACE_DIR=$TMPDIR/render-agents-workspaces   Checkout root
  WORKFLOW=characterize            Workflow name to dispatch
  HEALTH_TIMEOUT_SEC=60            Seconds to wait for /health

Provider key (required — the native engine calls the model):
  ANTHROPIC_API_KEY or OPENAI_API_KEY (from the env or examples/demo/.env)

Stop the gateway this script started:
  kill "$(cat "$SPIKE_LOG_DIR/gateway.pid")"

See docs/epic-2/code-migrator/docs/sprints/00-mvp/01-characterization-notes.md
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEMO_DIR}/../.." && pwd)"

PORT="${PORT:-3015}"
RENDER_AGENTS_API_KEY="${RENDER_AGENTS_API_KEY:-dev-key}"
WORKFLOW="${WORKFLOW:-characterize}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-60}"
SPIKE_LOG_DIR="${SPIKE_LOG_DIR:-${TMPDIR:-/tmp}/characterize-spike-logs}"
SKIP_BUILD="${SKIP_BUILD:-0}"
NO_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-start) NO_START=1 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[spike-characterize] %s\n' "$*"; }
die() { printf '[spike-characterize] error: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

load_provider_key() {
  [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${OPENAI_API_KEY:-}" ]] && return 0
  local env_file="${DEMO_DIR}/.env"
  [[ -f "${env_file}" ]] || return 0
  set -a
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ANTHROPIC_API_KEY=*|OPENAI_API_KEY=*) export "${line?}" ;;
    esac
  done < "${env_file}"
  set +a
}

check_provider_key() {
  load_provider_key
  if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
    die "no LLM provider key. Export ANTHROPIC_API_KEY or OPENAI_API_KEY (or add it to ${DEMO_DIR}/.env)."
  fi
}

gateway_health_ok() { curl -sf -m2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do gateway_health_ok && return 0; sleep 1; done
  return 1
}

maybe_build() {
  [[ "${SKIP_BUILD}" == "1" ]] && { log "skipping build (SKIP_BUILD=1)"; return 0; }
  log "building monorepo (pnpm install && pnpm build)"
  (cd "${REPO_ROOT}" && pnpm install && pnpm build)
}

start_gateway() {
  mkdir -p "${SPIKE_LOG_DIR}"
  local pid_file="${SPIKE_LOG_DIR}/gateway.pid" log_file="${SPIKE_LOG_DIR}/gateway.log"
  gateway_health_ok && { log "gateway already healthy on :${PORT} — reusing"; return 0; }
  log "starting gateway (memory store, inline) on :${PORT} — log: ${log_file}"
  (
    cd "${DEMO_DIR}"
    unset DATABASE_URL RENDER_USE_LOCAL_DEV RENDER_LOCAL_DEV_URL
    export PORT="${PORT}" RENDER_AGENTS_API_KEY="${RENDER_AGENTS_API_KEY}"
    export RENDER_AGENTS_ENCRYPTION_KEY="${RENDER_AGENTS_ENCRYPTION_KEY:-m05-spike-encryption-key-0123456789abcd}"
    load_provider_key
    nohup pnpm exec tsx src/server.ts >>"${log_file}" 2>&1 &
    echo $! >"${pid_file}"
  )
  wait_for_health || die "gateway did not become healthy within ${HEALTH_TIMEOUT_SEC}s — see ${log_file}"
  log "gateway healthy (pid $(cat "${pid_file}"))"
}

dispatch_workflow() {
  log "dispatching POST /workflows/${WORKFLOW} (this blocks until generation + certification finish)"
  local response
  response="$(curl -s -X POST "http://127.0.0.1:${PORT}/workflows/${WORKFLOW}" \
    -H "Authorization: Bearer ${RENDER_AGENTS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"input":{}}')"
  cat <<EOF

=== Characterization spike dispatched ===
Response:    ${response}
Operator UI: http://127.0.0.1:${PORT}/ui

Inspect the run + certification in /ui, or re-fetch:
  curl -s "http://127.0.0.1:${PORT}/runs/<id>" -H "Authorization: Bearer ${RENDER_AGENTS_API_KEY}"

Stop the gateway this script started:
  kill "\$(cat ${SPIKE_LOG_DIR}/gateway.pid)"

Pass criteria: certification.ok === true (G0 determinism + G2 mutation score ≥ 0.75)
Notes: docs/epic-2/code-migrator/docs/sprints/00-mvp/01-characterization-notes.md
EOF
}

main() {
  log "characterization spike — repo ${REPO_ROOT}"
  require_cmd node
  require_cmd git
  require_cmd curl
  check_provider_key
  maybe_build
  if [[ "${NO_START}" -eq 0 ]]; then start_gateway; else gateway_health_ok || die "gateway not healthy on :${PORT} (--no-start)"; fi
  dispatch_workflow
}

main "$@"
