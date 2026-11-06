#!/usr/bin/env bash
# Stops the fixture server start.sh started, with the given signal (TERM unless given), and waits
# until it is gone: orb -m <name> bash stop.sh [KILL|TERM]
set -uo pipefail

SIGNAL=${1:-TERM}
pid=$(cat "$HOME/cw.pid" 2>/dev/null) || exit 0
kill -"$SIGNAL" "$pid" 2>/dev/null || { rm -f "$HOME/cw.pid"; exit 0; }
for _ in $(seq 1 300); do
	kill -0 "$pid" 2>/dev/null || break
	sleep 0.1
done
kill -KILL "$pid" 2>/dev/null
rm -f "$HOME/cw.pid"
exit 0
