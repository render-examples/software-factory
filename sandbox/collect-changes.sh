#!/usr/bin/env bash
# Collects the changes in <repo_dir>'s working tree against <base_sha> into one file the host downloads.
# Usage: collect-changes.sh <repo_dir> <base_sha> <out_file> <max_changed_files> <max_file_bytes>
#
# Git runs against a throwaway git dir that borrows <repo_dir>/.git/objects as an alternate, so nothing the
# agent wrote into .git (config, filter drivers, hooks, replace refs, grafts, the index) takes effect, and the
# repository itself is never modified. The index starts from <base_sha>'s tree and `git add -A` brings it to
# the working tree, so .gitignore applies to untracked files.
#
# <out_file> must not exist. It holds, in order:
#   software-factory-changes 1\n
#   tree <sha of the staged tree, from git write-tree>\n
#   count <number of changed paths>\n
#   diff <n>\n <n bytes: git diff-tree -r -z --no-renames --no-abbrev <base tree> <tree>> \n
#   sizes <n>\n <n bytes: "<blob sha> <size>\n" per distinct blob of an added or modified regular file> \n
#   blobs <n>\n <n bytes: git cat-file --batch output for those blobs> \n
# diff is empty when count exceeds <max_changed_files>. sizes and blobs are empty when diff is, and blobs is
# empty when any blob exceeds <max_file_bytes> or any path becomes a symlink or gitlink: content that would
# be refused is never written. Prints the size of <out_file> in bytes.
set -euo pipefail
export LC_ALL=C

die() {
	echo "collect-changes: $*" >&2
	exit 2
}

[ "$#" -eq 5 ] || die "usage: collect-changes.sh <repo_dir> <base_sha> <out_file> <max_changed_files> <max_file_bytes>"
repo_dir=$1
base_sha=$2
out_file=$3
max_files=$4
max_bytes=$5

[[ $base_sha =~ ^[0-9a-f]{40}$ ]] || die "base sha must be 40 lowercase hex characters"
[[ $max_files =~ ^[0-9]+$ ]] || die "max_changed_files must be a non-negative integer"
[[ $max_bytes =~ ^[0-9]+$ ]] || die "max_file_bytes must be a non-negative integer"
[ -d "$repo_dir/.git/objects" ] || die "$repo_dir/.git/objects is not a directory"
if [ -e "$out_file" ] || [ -L "$out_file" ]; then die "$out_file already exists"; fi

objects=$(cd "$repo_dir/.git/objects" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/collect-changes.XXXXXX")
trap 'rm -rf "$work"' EXIT

git_dir="$work/git"
mkdir -p "$git_dir/objects/info" "$git_dir/refs"
printf 'ref: refs/heads/main\n' >"$git_dir/HEAD"
printf '%s\n' "$objects" >"$git_dir/objects/info/alternates"

for name in "${!GIT_@}"; do
	unset "$name"
done
export GIT_DIR="$git_dir"
export GIT_WORK_TREE="$repo_dir"
export GIT_INDEX_FILE="$git_dir/index"
export GIT_NO_REPLACE_OBJECTS=1
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_LITERAL_PATHSPECS=1
export GIT_TERMINAL_PROMPT=0
export GIT_OPTIONAL_LOCKS=0
export HOME="$work"
export XDG_CONFIG_HOME="$work"

g() {
	git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c safe.directory='*' -c core.untrackedCache=false \
		-c core.autocrlf=false -c core.safecrlf=false -c core.symlinks=true -c core.fileMode=true \
		-c core.ignoreCase=false -c core.quotePath=false --literal-pathspecs "$@"
}

cd "$repo_dir"
base_tree=$(g rev-parse --verify --quiet "${base_sha}^{tree}") || die "base commit $base_sha is not in the repository"
g read-tree "$base_tree"
g add -A
tree=$(g write-tree)
g diff-tree -r -z --no-renames --no-abbrev "$base_tree" "$tree" >"$work/diff"

count=$(($(tr -cd '\000' <"$work/diff" | wc -c) / 2))
withhold=0
: >"$work/blob-list"
: >"$work/sizes"
: >"$work/blobs"

if [ "$count" -gt "$max_files" ]; then
	: >"$work/diff"
else
	while IFS= read -r -d '' header && IFS= read -r -d '' _path; do
		read -r _old_mode new_mode _old_sha new_sha status <<<"${header#:}"
		[ "$status" = D ] && continue
		case $new_mode in
		100644 | 100755) printf '%s\n' "$new_sha" >>"$work/blob-list" ;;
		*) withhold=1 ;;
		esac
	done <"$work/diff"

	sort -u "$work/blob-list" | g cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)' >"$work/check"
	while read -r sha type size; do
		[ "$type" = blob ] || die "object $sha is a $type, not a blob"
		printf '%s %s\n' "$sha" "$size" >>"$work/sizes"
		if [ "$size" -gt "$max_bytes" ]; then withhold=1; fi
	done <"$work/check"

	if [ "$withhold" -eq 0 ]; then
		sort -u "$work/blob-list" | g cat-file --batch >"$work/blobs"
	fi
fi

section() {
	printf '%s %s\n' "$1" "$(wc -c <"$2" | tr -d ' ')"
	cat "$2"
	printf '\n'
}

set -o noclobber
{
	printf 'software-factory-changes 1\n'
	printf 'tree %s\n' "$tree"
	printf 'count %s\n' "$count"
	section diff "$work/diff"
	section sizes "$work/sizes"
	section blobs "$work/blobs"
} >"$out_file"
wc -c <"$out_file" | tr -d ' '
