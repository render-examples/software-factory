#!/usr/bin/env bash
# Verifies a factory sandbox: the builder before it is snapshotted, and every sandbox restored from the snapshot.
# Fails unless the layout, tools, and credential hygiene are as built, the checkout is at the manifest's commit
# and writable by the runner user, scratch is writable, and the runner passes its self-test. As root it also
# confirms the runner's node is non-dumpable. Prints one JSON line describing the sandbox.
# Usage: verify.sh
set -euo pipefail

app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"
fail() {
	printf 'verify: %s\n' "$*" >&2
	exit 1
}
as_runner() { bash "$app/as-runner.sh" "$@"; }
[ $# -eq 0 ] || fail "unexpected arguments: $*"

# ── Layout and tools ─────────────────────────────────────────────────────

for d in "$FACTORY_APP_DIR" "$FACTORY_REPO_DIR" "$FACTORY_SCRATCH_DIR"; do [ -d "$d" ] || fail "missing $d"; done
for f in as-runner.sh run-agent.sh lockfile-hash.sh build/git-credential-staged.sh build/scrub-credentials.sh runner/runner.mjs manifest.json; do
	[ -f "$FACTORY_APP_DIR/$f" ] || fail "missing $FACTORY_APP_DIR/$f"
done
for tool in git rg timeout sha256sum; do PATH="$FACTORY_PATH" command -v "$tool" >/dev/null || fail "missing $tool"; done
node_version=$("$FACTORY_NODE" -p 'process.versions.node') || fail "node does not run"
[ "${node_version%%.*}" -ge 22 ] || fail "node $node_version is older than 22"

# ── Credential hygiene ───────────────────────────────────────────────────
# No stored credentials or credential helpers may survive into the snapshot.

pattern='^(credential\.|url\..*\.insteadof|http\..*\.extraheader)'
for f in "$HOME/.git-credentials" "$FACTORY_SCRATCH_DIR/home/.git-credentials"; do [ ! -e "$f" ] || fail "$f exists"; done
for scope in --system --global; do
	if git config "$scope" --get-regexp "$pattern" >/dev/null 2>&1; then fail "credential settings in git $scope config"; fi
done
if git config --file "$FACTORY_APP_DIR/gitconfig" --get-regexp "$pattern" >/dev/null 2>&1; then fail "credential settings in $FACTORY_APP_DIR/gitconfig"; fi
g() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$FACTORY_REPO_DIR" "$@"; }
[ -d "$FACTORY_REPO_DIR/.git" ] || fail "$FACTORY_REPO_DIR is not a git checkout"
if g config --local --get-regexp "$pattern" >/dev/null 2>&1; then fail "credential settings in $FACTORY_REPO_DIR/.git/config"; fi
url=$(g config --local --get remote.origin.url || true)
case "$url" in *@*) fail "remote URL carries credentials" ;; esac

# ── Manifest and checkout ────────────────────────────────────────────────

commit=$("$FACTORY_NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha)' "$FACTORY_APP_DIR/manifest.json") ||
	fail "cannot read manifest"
head=$(g rev-parse HEAD 2>&1) || fail "$head"
[ "$head" = "$commit" ] || fail "HEAD $head != manifest $commit"
dirty=$(g status --porcelain --untracked-files=no 2>&1) || fail "git status failed: $dirty"
[ -z "$dirty" ] || fail "tracked files modified in $FACTORY_REPO_DIR: $(printf '%s' "$dirty" | head -n 5 | tr '\n' ' ')"

# ── Runner self-test ─────────────────────────────────────────────────────

self_test=$(as_runner "$FACTORY_RUNNER_NODE" "$FACTORY_APP_DIR/runner/runner.mjs" --self-test) || fail "runner self-test failed"

# ── Non-dumpable check ───────────────────────────────────────────────────
# An execute-only runner node keeps its memory (the model key) from same-uid tool subprocesses via /proc.

non_dumpable=false
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then
	pidfile="$FACTORY_SCRATCH_DIR/.factory-dumpable-probe.pid"
	rm -f "$pidfile"
	as_runner "$FACTORY_RUNNER_NODE" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)' "$pidfile" &
	launcher=$!
	for _ in $(seq 1 100); do
		[ -s "$pidfile" ] && break
		sleep 0.2
	done
	pid=$(cat "$pidfile" 2>/dev/null) || fail "$FACTORY_RUNNER_NODE did not start"
	stop_probe() {
		kill "$pid" 2>/dev/null || true
		wait "$launcher" 2>/dev/null || true
		rm -f "$pidfile"
	}
	if err=$(as_runner cat "/proc/$pid/maps" 2>&1 >/dev/null); then
		stop_probe
		fail "runner is dumpable: $FACTORY_RUN_AS can read /proc/$pid/maps of $FACTORY_RUNNER_NODE"
	fi
	stop_probe
	case "$err" in *"Permission denied"*) non_dumpable=true ;; *) fail "dumpability probe inconclusive: $err" ;; esac
fi

# ── Permissions ──────────────────────────────────────────────────────────

probe=".factory-write-probe-$$"
as_runner touch "$FACTORY_REPO_DIR/$probe" 2>/dev/null || fail "$FACTORY_REPO_DIR is not writable by $FACTORY_RUN_AS"
rm -f "$FACTORY_REPO_DIR/$probe"
as_runner touch "$FACTORY_SCRATCH_DIR/tmp/$probe" || fail "scratch is not writable by $FACTORY_RUN_AS"
rm -f "$FACTORY_SCRATCH_DIR/tmp/$probe"
if [ "$(id -u)" = 0 ] && [ "$FACTORY_RUN_AS" != root ]; then
	if as_runner touch "$FACTORY_APP_DIR/$probe" 2>/dev/null; then
		rm -f "$FACTORY_APP_DIR/$probe"
		fail "$FACTORY_APP_DIR is writable by $FACTORY_RUN_AS"
	fi
fi

# ── Cleanup and report ───────────────────────────────────────────────────
# Only tmp is cleared: HOME may hold dependency caches an install relies on (Go modules, Poetry venvs).

find "$FACTORY_SCRATCH_DIR/tmp" -mindepth 1 -delete

"$FACTORY_NODE" -e '
const [runAs, uid, drop, selfTest, nonDumpable] = process.argv.slice(1);
console.log(JSON.stringify({
  runAs, uid: Number(uid), drop, node: process.version,
  runnerNonDumpable: nonDumpable === "true",
  selfTest: JSON.parse(selfTest.trim().split("\n").pop()),
}));
' "$FACTORY_RUN_AS" "$(id -u)" "$FACTORY_DROP" "$self_test" "$non_dumpable"
