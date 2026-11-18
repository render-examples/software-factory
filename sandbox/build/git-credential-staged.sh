#!/usr/bin/env bash
set -euo pipefail

creds_dir=$1
action=${2:-}
[ "$action" = get ] || exit 0

host=""
while IFS= read -r line; do
	case "$line" in host=*) host=${line#host=} ;; esac
done
case "$host" in "" | *[!A-Za-z0-9.:-]* | .*) exit 0 ;; esac

file="$creds_dir/$host"
[ -s "$file" ] || exit 0
{ IFS= read -r username && { IFS= read -r token || [ -n "$token" ]; }; } <"$file"
printf 'username=%s\npassword=%s\n' "$username" "$token"
