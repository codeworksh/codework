const units = [
	{ unit: "d", ms: 24 * 60 * 60 * 1000 },
	{ unit: "h", ms: 60 * 60 * 1000 },
	{ unit: "m", ms: 60 * 1000 },
] as const;

/** Compact relative time: "5h", "3d", "now". */
export function ago(time: number) {
	const elapsed = Date.now() - time;
	const match = units.find(({ ms }) => elapsed >= ms);
	return match === undefined ? "now" : `${Math.floor(elapsed / match.ms)}${match.unit}`;
}
