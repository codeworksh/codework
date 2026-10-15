// The codework.sh pixel wordmark: square strokes and stepped corners on a 10-row grid.
const LETTERS: Record<string, readonly string[]> = {
	C: [
		"##########",
		"##########",
		"##........",
		"##........",
		"##........",
		"##........",
		"##........",
		"##........",
		"##########",
		"##########",
	],
	O: [
		".########.",
		"##########",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##########",
		".########.",
	],
	D: [
		"########..",
		"#########.",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"#########.",
		"########..",
	],
	E: [
		"##########",
		"##########",
		"##........",
		"##........",
		"#######...",
		"#######...",
		"##........",
		"##........",
		"##########",
		"##########",
	],
	W: [
		"##...##...##",
		"##...##...##",
		"##...##...##",
		"##...##...##",
		"##...##...##",
		"##...##...##",
		"##...##...##",
		"###.####.###",
		".##########.",
		"..###..###..",
	],
	R: [
		"########..",
		"#########.",
		"##......##",
		"##......##",
		"#########.",
		"########..",
		"##...##...",
		"##....##..",
		"##.....##.",
		"##......##",
	],
	K: [
		"##......##",
		"##.....##.",
		"##....##..",
		"##...##...",
		"######....",
		"######....",
		"##...##...",
		"##....##..",
		"##.....##.",
		"##......##",
	],
};

// One empty cell between letters and on the right and bottom edges leaves room for the echoes.
const letters = "CODEWORK".split("").map((char) => LETTERS[char]!);
const rows = [...Array.from({ length: 10 }, (_, row) => `${letters.map((letter) => letter[row]!).join(".")}.`), ""].map(
	(line) => line.replaceAll("#", "1").replaceAll(".", "0"),
);
const width = rows[0]!.length;
const height = rows.length;

const filled = (col: number, row: number) => rows[row]?.[col] === "1";
const sides = [
	[-1, 0, 0, 0, 0, 1],
	[1, 0, 1, 0, 1, 1],
	[0, -1, 0, 0, 1, 0],
	[0, 1, 0, 1, 1, 1],
] as const;
// Exposed cell edges, stroked at an offset to give the letters depth.
const outline = rows
	.flatMap((bits, row) =>
		bits
			.split("")
			.flatMap((_, col) =>
				filled(col, row)
					? sides.flatMap(([dx, dy, x1, y1, x2, y2]) =>
							filled(col + dx, row + dy) ? [] : [`M${col + x1} ${row + y1}L${col + x2} ${row + y2}`],
						)
					: [],
			),
	)
	.join("");
// The echoes take the palette's field inks, as on codework.sh.
const depth = [
	{ offset: 0.65, ink: "var(--t-field-mid)" },
	{ offset: 0.32, ink: "var(--t-field-lit)" },
];

/** The wordmark in `currentColor`, with outline echoes behind it. */
export function Wordmark({ className }: { className?: string }) {
	return (
		<svg viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" aria-hidden className={className}>
			{depth.map(({ offset, ink }) => (
				<path
					key={offset}
					d={outline}
					transform={`translate(${offset} ${offset})`}
					fill="none"
					stroke={ink}
					strokeWidth={0.08}
				/>
			))}
			{rows.flatMap((bits, y) =>
				[...bits.matchAll(/1+/g)].map((run) => (
					<rect
						key={`${y}-${run.index}`}
						x={run.index}
						y={y}
						width={run[0].length}
						height={1}
						fill="currentColor"
					/>
				)),
			)}
		</svg>
	);
}
