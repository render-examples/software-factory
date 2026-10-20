#!/usr/bin/env bash
# Runs after a clone or fetch, before any agent or repository code. Fails if any staged token value made it
# into a git config, a credential store, or the checkout's .git directory; otherwise deletes the staged
# credentials and confirms no credential setting survives.
# Usage: scrub-credentials.sh <creds_dir> <repo_dir> [<extra_home>...]
set -euo pipefail

creds_dir=$1
repo_dir=$2
shift 2
homes=("$HOME" "$@")
fail() {
	printf 'scrub-credentials: %s\n' "$*" >&2
	exit 1
}
[ -d "$repo_dir/.git" ] || fail "$repo_dir is not a git checkout"

# ── Search for each token value ──────────────────────────────────────────
# grep -F -f reads the pattern from a file, so the token never appears in argv (visible in /proc).

if [ -d "$creds_dir" ]; then
	pattern_file=$(mktemp)
	trap 'rm -f "$pattern_file"' EXIT
	for cf in "$creds_dir"/*; do
		[ -s "$cf" ] || continue
		sed -n '2p' "$cf" >"$pattern_file"
		[ -s "$pattern_file" ] || continue
		for h in "${homes[@]}"; do
			for f in "$h/.gitconfig" "$h/.git-credentials" "$h/.config/git"; do
				if [ -e "$f" ] && grep -rqsF -f "$pattern_file" -- "$f"; then fail "token for $(basename "$cf") found in $f"; fi
			done
		done
		if [ -e /etc/gitconfig ] && grep -qsF -f "$pattern_file" -- /etc/gitconfig; then fail "token for $(basename "$cf") found in /etc/gitconfig"; fi
		if grep -rqsF --exclude-dir=objects -f "$pattern_file" -- "$repo_dir/.git"; then fail "token for $(basename "$cf") found in $repo_dir/.git"; fi
	done
fi

rm -rf "$creds_dir"
[ ! -e "$creds_dir" ] || fail "could not delete $creds_dir"

# ── No credential settings may survive ───────────────────────────────────

settings='^(credential\.|url\..*\.insteadof|http\..*\.extraheader)'
for h in "${homes[@]}"; do
	[ ! -e "$h/.git-credentials" ] || fail "$h/.git-credentials exists"
done
for scope in --system --global; do
	if git config "$scope" --get-regexp "$settings" >/dev/null 2>&1; then fail "credential settings in git $scope config"; fi
done
if git -c safe.directory='*' -C "$repo_dir" config --local --get-regexp "$settings" >/dev/null 2>&1; then fail "$repo_dir: credential settings"; fi
url=$(git -c safe.directory='*' -C "$repo_dir" config --local --get remote.origin.url 2>/dev/null || true)
case "$url" in *@*) fail "$repo_dir: remote URL carries credentials" ;; esac
