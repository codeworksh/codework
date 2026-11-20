#!/usr/bin/env bash
# Prepares an OrbStack Linux machine to run the CodeWork fixture server: system tools, Node and
# pnpm, a copy of the checkout with its own Linux install. Idempotent; run inside the machine:
#   orb -m <name> bash setup.sh <checkout>
# <checkout> is a path to the repository the machine sees through the Mac mount.
set -euo pipefail

SRC=$1
NODE_VERSION=v26.13.0
PNPM_VERSION=12.14.0
DIR=$HOME/codework
NODE_DIR=$HOME/.local/node
export PATH=$NODE_DIR/bin:$PATH

# iptables cuts the network, tc throttles it, sqlite3 reads the harness store.
if ! command -v iptables >/dev/null || ! command -v tc >/dev/null || ! command -v sqlite3 >/dev/null \
	|| ! command -v xz >/dev/null || ! command -v git >/dev/null || ! command -v curl >/dev/null; then
	if command -v dnf >/dev/null; then
		sudo dnf install -y -q iptables-nft iproute-tc sqlite xz git curl tar
	else
		sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables iproute2 sqlite3 xz-utils git curl ca-certificates
	fi
fi

if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
	arch=$(uname -m)
	case $arch in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; esac
	rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
	curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$arch.tar.xz" \
		| tar -xJ -C "$NODE_DIR" --strip-components=1
fi
if [ "$(pnpm -v 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
	npm install -g --silent "pnpm@$PNPM_VERSION"
fi

# Two suites setting up one machine at once would copy and install over each other.
exec 9>"$HOME/cw-setup.lock"
flock 9

# A clone from before the copy below; its files are not in .files, so they would never be pruned.
if [ -d "$DIR/.git" ]; then
	rm -rf "$DIR"
fi
mkdir -p "$DIR"

# The checkout as git sees it, uncommitted and untracked files included, ignored ones (node_modules,
# builds, .repos) left out. Files gone since the last copy are pruned, so a removed workspace package
# cannot linger and fail the frozen install.
list() { git -C "$SRC" ls-files -z "$@" | tr '\0' '\n' | grep -v '/__artifacts__/' | LC_ALL=C sort; }
LC_ALL=C comm -23 <(list -co --exclude-standard) <(list -d) >"$DIR/.files.new"
copy() { tar -C "$SRC" -T "$DIR/.files.new" -cf - | tar -C "$DIR" -xf -; }
# The mount shows a file the Mac just wrote stale for a moment, and tar fails on it as changed mid-read.
copy || { sleep 1 && copy; }
if [ -f "$DIR/.files" ]; then
	LC_ALL=C comm -23 "$DIR/.files" "$DIR/.files.new" | (cd "$DIR" && xargs -r -d '\n' rm -f --)
fi
mv "$DIR/.files.new" "$DIR/.files"
cp "$SRC/models.gen.json" "$DIR/models.gen.json"

# Only what the fixture server imports: the app server's tree and the CLI's, with their builds. It
# reruns when the lockfile, workspace config, patches or any package.json changed.
key=$(cd "$DIR" && grep -E '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|patches/.*|(.*/)?package\.json)$' .files \
	| xargs -d '\n' sha256sum | sha256sum | cut -d' ' -f1)
if [ "$(cat "$DIR/.installed" 2>/dev/null || true)" != "$key" ] || [ ! -d "$DIR/apps/server/node_modules" ]; then
	if ! (cd "$DIR" && CI=1 pnpm install --frozen-lockfile \
		--filter "@codeworksh/server..." --filter "@codeworksh/cli...") >"$HOME/cw-install.log" 2>&1; then
		echo "pnpm install --frozen-lockfile failed on $(hostname) for the manifests and lockfile of $SRC" \
			"(full log: ~/cw-install.log):" >&2
		tail -n 40 "$HOME/cw-install.log" >&2
		exit 1
	fi
	echo "$key" >"$DIR/.installed"
	echo "installed: $key"
fi
echo "setup done: $(node -v), pnpm $(pnpm -v)"
