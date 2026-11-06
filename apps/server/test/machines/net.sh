#!/usr/bin/env bash
# Misbehaves the machine's network for the fixture server's port, from inside the machine:
#   orb -m <name> bash net.sh cut|restore|slow|fast
# cut drops RPC traffic on eth0 both ways (loopback stays open, so the machine can still drive its
# own server); slow delays and rate-limits everything eth0 sends.
set -euo pipefail

PORT=7433
IF=eth0
rules=("INPUT -i $IF -p tcp --dport $PORT -j DROP" "OUTPUT -o $IF -p tcp --sport $PORT -j DROP")
case $1 in
cut)
	for rule in "${rules[@]}"; do
		# shellcheck disable=SC2086
		sudo iptables -C $rule 2>/dev/null || sudo iptables -I $rule
	done
	;;
restore)
	for rule in "${rules[@]}"; do
		# shellcheck disable=SC2086
		while sudo iptables -C $rule 2>/dev/null; do sudo iptables -D $rule; done
	done
	;;
slow) sudo tc qdisc replace dev "$IF" root netem delay 300ms rate 256kbit ;;
fast) sudo tc qdisc del dev "$IF" root 2>/dev/null || true ;;
*)
	echo "usage: net.sh cut|restore|slow|fast" >&2
	exit 2
	;;
esac
