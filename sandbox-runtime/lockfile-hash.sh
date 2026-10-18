#!/usr/bin/env bash
# Prints the sha256 of the repository's dependency lockfiles: one "<sha256>  <name>" line per lockfile present
# at the root of <repo_dir>, in sorted order, hashed together. With no lockfiles it prints the hash of nothing.
# Usage: lockfile-hash.sh <repo_dir>
set -euo pipefail

cd "$1"
names=(package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lockb go.sum Cargo.lock poetry.lock uv.lock Gemfile.lock composer.lock)
for f in requirements*.txt; do
	if [ -e "$f" ]; then names+=("$f"); fi
done

printf '%s\n' "${names[@]}" | LC_ALL=C sort -u | while IFS= read -r f; do
	[ -f "$f" ] || continue
	printf '%s  %s\n' "$(sha256sum <"$f" | cut -d' ' -f1)" "$f"
done | sha256sum | cut -d' ' -f1
