/** A pixel glyph: rows of "1"/"0" cells, drawn on the hero field's grid. */
export type Glyph = { rows: readonly string[]; width: number; height: number };

// Letters share a 9-column cell, 16 rows tall; W is wider and drops a notch below the line.
const LETTERS: Record<string, readonly string[]> = {
	C: [
		"..#######",
		".########",
		"###...###",
		"###...###",
		"###...##.",
		"###...#..",
		"###......",
		"###......",
		"###......",
		"###......",
		"###...#..",
		"###...##.",
		"###...###",
		"###...###",
		".########",
		"..#######",
	],
	O: [
		"..#####..",
		".#######.",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		".#######.",
		"..#####..",
	],
	D: [
		"#######..",
		"########.",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"########.",
		"#######..",
	],
	E: [
		"..#######",
		".########",
		"###......",
		"###......",
		"###......",
		"###......",
		"###......",
		"#######..",
		"#######..",
		"###......",
		"###......",
		"###......",
		"###......",
		"###......",
		".########",
		"..#######",
	],
	W: [
		"..#...###...#..",
		".##...###...##.",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		"###...###...###",
		".#############.",
		"..###########..",
		"......###......",
	],
	R: [
		"#######..",
		"########.",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"########.",
		"#######..",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...###",
		"###...##.",
		"###...#..",
	],
	K: [
		"###...###",
		"###...###",
		"###..###.",
		"###..###.",
		"###.###..",
		"###.###..",
		"######...",
		"#####....",
		"#####....",
		"######...",
		"###.###..",
		"###.###..",
		"###..###.",
		"###..###.",
		"###...###",
		"###...###",
	],
};

function compose(word: string): Glyph {
	const letters = word.split("").map((char) => LETTERS[char]!);
	const height = Math.max(...letters.map((rows) => rows.length));
	const rows = Array.from({ length: height }, (_, row) =>
		letters
			.map((rows) => (rows[row] ?? ".".repeat(rows[0]!.length)).replaceAll("#", "1").replaceAll(".", "0"))
			.join("0"),
	);
	return { rows, width: rows[0]!.length, height };
}

export const WORDMARK = compose("CODEWORK");

/** The mark: a terminal prompt in a frame. Header logo, and the stamp a click leaves on the field. */
export const MARK: Glyph = {
	width: 15,
	height: 15,
	rows: [
		"111111111111111",
		"100000000000001",
		"100000000000001",
		"101100000000001",
		"100110000000001",
		"100011000000001",
		"100001100000001",
		"100011000000001",
		"100110000000001",
		"101100011111001",
		"100000000000001",
		"100000000000001",
		"100000000000001",
		"100000000000001",
		"111111111111111",
	],
};

/** Resting ink per band, top to bottom, as rows of a 19-row reference height. */
const BANDS = [
	["crest", 5],
	["hover", 2],
	["lit", 4],
	["mid", 3],
	["dim", 5],
] as const;
export type Ink = (typeof BANDS)[number][0];
const BAND_ROWS = BANDS.reduce((sum, [, rows]) => sum + rows, 0);

/** The band a row of a glyph rests in, spread in proportion to the glyph's height. */
export function bandOf(row: number, height: number): Ink {
	let at = (row / height) * BAND_ROWS;
	for (const [ink, rows] of BANDS) {
		if (at < rows) return ink;
		at -= rows;
	}
	return "dim";
}
