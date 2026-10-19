#!/usr/bin/env bash
# Runs the agent runner once as the runner user from the repository checkout, bounded by coreutils timeout.
# Usage: run-agent.sh <run_dir> <timeout_seconds>
# <run_dir>/input.json is fed on stdin. <run_dir>/key, when present, is the model API key. It is read and deleted
# while <run_dir> is still root-only (mode 700), before <run_dir> is handed to the runner user, and reaches the
# runner as the first line of its stdin (--key-stdin), so it never exists as a file the runner user can read.
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

key_file="$run_dir/key"
trap 'rm -f "$key_file"' EXIT
has_key=false key=""
if [ -f "$key_file" ]; then
	has_key=true
	key=$(<"$key_file")
	rm -f "$key_file"
	if [ -e "$key_file" ]; then
		echo "run-agent: cannot delete $key_file" >&2
		exit 1
	fi
	if [[ $key == *$'\n'* ]]; then
		echo "run-agent: $key_file holds more than one line" >&2
		exit 1
	fi
fi
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then chown -R "$FACTORY_RUN_AS": "$run_dir"; fi

runner=(timeout --kill-after=10s "$seconds" bash "$app/as-runner.sh" "$FACTORY_RUNNER_NODE" "$FACTORY_APP_DIR/runner/runner.mjs")
set +e
if [ "$has_key" = true ]; then
	# key is never exported and printf is a bash builtin, so it reaches no process's argv or environment.
	{ printf '%s\n' "$key"; cat "$run_dir/input.json"; } | "${runner[@]}" --key-stdin >"$run_dir.jsonl"
	status=${PIPESTATUS[1]}
else
	"${runner[@]}" <"$run_dir/input.json" >"$run_dir.jsonl"
	status=$?
fi
set -e
echo "$status" >"$run_dir.exit"
exit "$status"
