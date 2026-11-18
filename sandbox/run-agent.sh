#!/usr/bin/env bash
set -euo pipefail

run_dir=${1:?usage: run-agent.sh <run_dir> <timeout_seconds>}
seconds=${2:?usage: run-agent.sh <run_dir> <timeout_seconds>}
run_dir=${run_dir%/}
: >"$run_dir.jsonl"
echo "$$" >"$run_dir.pid"
app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"

key_file="$run_dir/key"
trap 'rm -f "$key_file"' EXIT
if [ ! -f "$key_file" ]; then
	echo "run-agent: $key_file is missing" >&2
	exit 1
fi
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
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then chown -R "$FACTORY_RUN_AS": "$run_dir"; fi

set +e
{ printf '%s\n' "$key"; cat "$run_dir/input.json"; } |
	timeout --kill-after=10s "$seconds" bash "$app/as-runner.sh" "$FACTORY_RUNNER_NODE" "$FACTORY_APP_DIR/runner/runner.mjs" --key-stdin |
	tee -p "$run_dir.jsonl"
status=${PIPESTATUS[1]}
set -e
echo "$status" >"$run_dir.exit"
exit "$status"
