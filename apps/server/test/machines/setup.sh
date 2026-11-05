#!/usr/bin/env bash
# Prepares an OrbStack Linux machine to run the CodeWork fixture server: system tools, Node and
# pnpm, a clone of the repository with its own Linux install. Idempotent; run inside the machine:
#   orb -m <name> bash setup.sh <checkout>
# <checkout> is a path to the repository the machine sees through the Mac mount.
set -euo pipefail

SRC=$1
COMMIT=b9ee11acc # the lockfile the install is made from; sources are overlaid by start.sh
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

if [ ! -d "$DIR/.git" ]; then
	git clone -q "$SRC" "$DIR"
fi
if [ ! -f "$DIR/pnpm-lock.yaml" ] || [ "$(git -C "$DIR" rev-parse HEAD)" != "$(git -C "$SRC" rev-parse "$COMMIT")" ]; then
	git -C "$DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$DIR" fetch -q "$SRC" "$COMMIT"
	git -C "$DIR" checkout -q -f --detach "$COMMIT"
fi

# Only what the fixture server imports: the app server's tree and the CLI's, with their builds.
if [ "$(cat "$DIR/.installed" 2>/dev/null || true)" != "$COMMIT" ] || [ ! -d "$DIR/apps/server/node_modules" ]; then
	(cd "$DIR" && CI=1 pnpm install --frozen-lockfile --reporter=silent \
		--filter "@codeworksh/server..." --filter "@codeworksh/cli...")
	echo "$COMMIT" >"$DIR/.installed"
fi
cp "$SRC/models.gen.json" "$DIR/models.gen.json"
echo "setup done: $(node -v), pnpm $(pnpm -v), $(git -C "$DIR" rev-parse --short HEAD)"
