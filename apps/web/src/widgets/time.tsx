import { useNowMinute } from "@/hooks/now";

const units = [
	{ unit: "d", ms: 24 * 60 * 60 * 1000 },
	{ unit: "h", ms: 60 * 60 * 1000 },
	{ unit: "m", ms: 60 * 1000 },
] as const;

/** Compact relative time: "5h", "3d", "now". */
export function ago(time: number, now = Date.now()) {
	const elapsed = now - time;
	const match = units.find(({ ms }) => elapsed >= ms);
	return match === undefined ? "now" : `${Math.floor(elapsed / match.ms)}${match.unit}`;
}

/** `ago(time)`, kept current by the shared minute tick. */
export function Ago({ time }: { readonly time: number }) {
	return ago(time, useNowMinute());
}
