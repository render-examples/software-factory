#!/usr/bin/env bash
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
