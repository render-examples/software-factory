#!/usr/bin/env bash
# Runs the agent runner once as the runner user from the repository checkout, bounded by coreutils timeout.
# Usage: run-agent.sh <run_dir> <timeout_seconds>
# <run_dir>/input.json is fed on stdin. <run_dir>/key, when present, is the model API key, passed as
# --key-file: the runner deletes it on read, and this script deletes it on exit regardless.
# The runner's stdout (JSONL events) goes to <run_dir>.jsonl and its exit status to <run_dir>.exit (124 or
# 137 on timeout). They sit beside <run_dir> rather than in it: <run_dir> is handed to the runner user,
# while these stay root-owned, so the agent cannot rewrite what the host reads.
set -euo pipefail

run_dir=${1:?usage: run-agent.sh <run_dir> <timeout_seconds>}
seconds=${2:?usage: run-agent.sh <run_dir> <timeout_seconds>}
run_dir=${run_dir%/}
app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"

key="$run_dir/key"
trap 'rm -f "$key"' EXIT
args=()
if [ -f "$key" ]; then args=(--key-file "$key"); fi
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then chown -R "$FACTORY_RUN_AS": "$run_dir"; fi

status=0
timeout --kill-after=10s "$seconds" bash "$app/as-runner.sh" "$FACTORY_RUNNER_NODE" "$FACTORY_APP_DIR/runner/runner.mjs" ${args[@]+"${args[@]}"} \
	<"$run_dir/input.json" >"$run_dir.jsonl" || status=$?
rm -f "$key"
echo "$status" >"$run_dir.exit"
exit "$status"
