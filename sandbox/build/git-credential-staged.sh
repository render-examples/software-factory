#!/usr/bin/env bash
# Git credential helper for the clone (snapshot build) and fetch (open) steps. Answers `get` from
# <creds_dir>/<host>, a file holding the username on line 1 and the token on line 2. The token never appears
# in argv, a URL, or git config.
# Usage (git appends the action): git -c credential.helper='!bash git-credential-staged.sh <creds_dir>' clone ...
set -euo pipefail

creds_dir=$1
action=${2:-}
[ "$action" = get ] || exit 0

host=""
while IFS= read -r line; do
	case "$line" in host=*) host=${line#host=} ;; esac
done
# Only plain host[:port] names map to a file; anything else (empty, slashes, dots-only tricks) gets no answer.
case "$host" in "" | *[!A-Za-z0-9.:-]* | .*) exit 0 ;; esac

file="$creds_dir/$host"
[ -s "$file" ] || exit 0
# The file is written without a trailing newline, so the last read returns non-zero after filling `token`.
{ IFS= read -r username && { IFS= read -r token || [ -n "$token" ]; }; } <"$file"
printf 'username=%s\npassword=%s\n' "$username" "$token"
