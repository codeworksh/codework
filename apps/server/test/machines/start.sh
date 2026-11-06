#!/usr/bin/env bash
# Starts the CodeWork fixture server (scripted model) in an OrbStack machine, on 0.0.0.0:7433 with
# the home ~/cw-home, after overlaying the checkout's sources on the machine's install:
#   orb -m <name> bash start.sh <checkout> [sweep]
# It logs to ~/cw.log and reads control lines (`release`) from the FIFO ~/cw.ctl. With `sweep` it
# only sweeps the store's open runs, in the foreground, and exits.
set -euo pipefail

SRC=$1
MODE=${2:-}
DIR=$HOME/codework
export PATH=$HOME/.local/node/bin:$PATH

bash "$(dirname "$0")/stop.sh" KILL

# The sources under test, not the install's commit; node_modules stay the machine's own.
tar -C "$SRC" --exclude=node_modules --exclude=__artifacts__ -cf - apps/server packages/aikit packages/codework \
	packages/harness packages/plugin | tar -C "$DIR" -xf -
cp "$SRC/models.gen.json" "$DIR/models.gen.json"

cd "$DIR"
run=(node --conditions=development apps/server/test/fixtures/codework.ts "$HOME/cw-home" 7433 0.0.0.0)
if [ "$MODE" = sweep ]; then
	"${run[@]}" sweep </dev/null
	exit 0
fi

rm -f "$HOME/cw.ctl" && mkfifo "$HOME/cw.ctl"
# Read-write, so the FIFO never reports end of input between control lines.
setsid nohup "${run[@]}" <>"$HOME/cw.ctl" >"$HOME/cw.log" 2>&1 &
echo $! >"$HOME/cw.pid"
for _ in $(seq 1 600); do
	if grep -q '"type":"ready"' "$HOME/cw.log"; then
		echo ready
		exit 0
	fi
	if ! kill -0 "$(cat "$HOME/cw.pid")" 2>/dev/null; then
		cat "$HOME/cw.log"
		exit 1
	fi
	sleep 0.1
done
echo "not ready after 60 s" >&2
exit 1
