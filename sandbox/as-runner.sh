#!/usr/bin/env bash
# Runs a command as $FACTORY_RUN_AS from the repository checkout with a minimal environment. As root it drops
# privileges with setpriv; otherwise it only scrubs the environment.
# Usage: as-runner.sh <command> [args...]
set -euo pipefail

# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/env"
home="$FACTORY_SCRATCH_DIR/home" tmp="$FACTORY_SCRATCH_DIR/tmp"
mkdir -p "$home" "$tmp"
drop=false
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then
	drop=true
	chown "$FACTORY_RUN_AS": "$home" "$tmp"
fi
cd "$FACTORY_REPO_DIR"

env_args=(
	HOME="$home" TMPDIR="$tmp" PATH="$FACTORY_PATH" LANG=C.UTF-8 USER="$FACTORY_RUN_AS"
	GIT_CONFIG_GLOBAL="$FACTORY_APP_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
)
if [ "$drop" = false ]; then exec env -i "${env_args[@]}" "$@"; fi
exec setpriv --reuid="$FACTORY_RUN_AS" --regid="$(id -g "$FACTORY_RUN_AS")" --init-groups --no-new-privs -- env -i "${env_args[@]}" "$@"
