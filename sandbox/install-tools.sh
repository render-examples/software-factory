#!/usr/bin/env bash
# Ensures git, ripgrep, coreutils timeout, setpriv, useradd, and Node >= 22 on the sandbox base image (Debian, as
# root). The image ships everything except ripgrep; apt-get installs whatever is missing.
# Usage: install-tools.sh
set -euo pipefail

log() { printf 'install-tools: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" = 0 ] || {
	log "must run as root"
	exit 1
}
pkgs=""
have git || pkgs="$pkgs git"
have rg || pkgs="$pkgs ripgrep"
have timeout || pkgs="$pkgs coreutils"
have setpriv || pkgs="$pkgs util-linux"
have useradd || pkgs="$pkgs passwd"
if [ -n "$pkgs" ]; then
	log "apt-get install$pkgs"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >&2
	# shellcheck disable=SC2086 # intentional word splitting of the package list
	apt-get install -y -qq --no-install-recommends ca-certificates $pkgs >&2
	rm -rf /var/lib/apt/lists/*
fi

missing=""
for tool in git rg timeout setpriv useradd node tar sha256sum; do have "$tool" || missing="$missing $tool"; done
if [ -n "$missing" ]; then
	log "missing tools:$missing"
	exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
	log "node $(node --version) is older than 22"
	exit 1
fi
log "git $(git --version | cut -d' ' -f3), rg $(rg --version | head -n 1 | cut -d' ' -f2), node $(node --version)"
