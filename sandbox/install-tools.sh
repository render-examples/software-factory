#!/usr/bin/env bash
# Ensures git, ripgrep, coreutils timeout, and Node >= 22. Uses apt-get when root; otherwise
# downloads checksum-verified official builds (Node into <app_dir>/node, rg into <app_dir>/bin).
# Usage: install-tools.sh <app_dir>
set -euo pipefail

app=$1
node_version=${FACTORY_NODE_VERSION:-v24.14.1}
rg_version=${FACTORY_RG_VERSION:-14.1.1}
log() { printf 'install-tools: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
fetch() {
	if have curl; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif have wget; then
		wget -q -O "$2" "$1"
	else
		log "need curl or wget to download $1"
		return 1
	fi
}
sha256() { sha256sum "$1" | cut -d' ' -f1; }

if [ "$(id -u)" = 0 ] && have apt-get; then
	pkgs=""
	have git || pkgs="$pkgs git"
	have rg || pkgs="$pkgs ripgrep"
	have timeout || pkgs="$pkgs coreutils"
	have curl || have wget || pkgs="$pkgs curl"
	have setpriv || have runuser || have su || pkgs="$pkgs util-linux"
	have useradd || pkgs="$pkgs passwd"
	if [ -n "$pkgs" ]; then
		log "apt-get install$pkgs"
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -qq >&2
		# shellcheck disable=SC2086 # intentional word splitting of the package list
		apt-get install -y -qq --no-install-recommends ca-certificates $pkgs >&2
		rm -rf /var/lib/apt/lists/*
	fi
fi

case "$(uname -m)" in
x86_64 | amd64) node_arch=x64 rg_target=x86_64-unknown-linux-musl ;;
aarch64 | arm64) node_arch=arm64 rg_target=aarch64-unknown-linux-gnu ;;
*)
	log "unsupported architecture $(uname -m)"
	exit 1
	;;
esac

if ! node_ok; then
	name="node-$node_version-linux-$node_arch.tar.gz"
	tmp=$(mktemp -d)
	fetch "https://nodejs.org/dist/$node_version/$name" "$tmp/$name"
	fetch "https://nodejs.org/dist/$node_version/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
	want=$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
	if [ -z "$want" ] || [ "$(sha256 "$tmp/$name")" != "$want" ]; then
		log "checksum mismatch for $name"
		exit 1
	fi
	mkdir -p "$app/node"
	tar -xzf "$tmp/$name" -C "$app/node" --strip-components=1
	rm -rf "$tmp"
	log "installed node $node_version into $app/node"
fi

if ! have rg; then
	name="ripgrep-$rg_version-$rg_target"
	base="https://github.com/BurntSushi/ripgrep/releases/download/$rg_version"
	tmp=$(mktemp -d)
	fetch "$base/$name.tar.gz" "$tmp/rg.tar.gz"
	fetch "$base/$name.tar.gz.sha256" "$tmp/rg.sha256"
	if [ "$(sha256 "$tmp/rg.tar.gz")" != "$(cut -d' ' -f1 <"$tmp/rg.sha256")" ]; then
		log "checksum mismatch for $name"
		exit 1
	fi
	tar -xzf "$tmp/rg.tar.gz" -C "$tmp"
	mkdir -p "$app/bin"
	install -m 755 "$tmp/$name/rg" "$app/bin/rg"
	rm -rf "$tmp"
	log "installed ripgrep $rg_version into $app/bin"
fi

export PATH="$app/bin:$app/node/bin:$PATH"
missing=""
for tool in git rg timeout node tar sha256sum; do have "$tool" || missing="$missing $tool"; done
if [ -n "$missing" ]; then
	log "missing tools:$missing (git and coreutils can only be installed as root via apt-get)"
	exit 1
fi
log "git $(git --version | cut -d' ' -f3), rg $(rg --version | head -n 1 | cut -d' ' -f2), node $(node --version)"
