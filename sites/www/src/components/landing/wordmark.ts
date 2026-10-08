/** A pixel glyph: 1 is the body, 2 is the cursor accent, 0 is empty. */
export type Glyph = { rows: readonly string[]; width: number; height: number };

// Square C and cursor match the logo; stepped corners give the other letters their shape.
const LETTERS: Record<string, readonly string[]> = {
	C: [
		"##########",
		"##########",
		"##........",
		"##........",
		"##......++",
		"##......++",
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

function compose(word: string): Glyph {
	const letters = word.split("").map((char) => LETTERS[char]!);
	const width = letters.reduce((sum, rows) => sum + rows[0]!.length + 1, 0);
	const rows = Array.from(
		{ length: 10 },
		(_, row) =>
			letters
				.map((letter) => letter[row]!.replaceAll("#", "1").replaceAll("+", "2").replaceAll(".", "0"))
				.join("0") + "0",
	);
	// One empty cell on the right and bottom leaves room for the outline echoes.
	return { rows: [...rows, "0".repeat(width)], width, height: 11 };
}

export const WORDMARK = compose("CODEWORK");
export type Ink = "crest" | "hover" | "lit" | "mid" | "dim";
export const DEPTH = [
	{ offset: 0.65, ink: "mid" },
	{ offset: 0.32, ink: "lit" },
] as const;

/** Exposed cell edges, shared by the SVG fallback and animated canvas. */
export function outlineOf(glyph: Glyph) {
	const filled = (col: number, row: number) => /[12]/.test(glyph.rows[row]?.[col] ?? "0");
	const sides = [
		[-1, 0, 0, 0, 0, 1],
		[1, 0, 1, 0, 1, 1],
		[0, -1, 0, 0, 1, 0],
		[0, 1, 0, 1, 1, 1],
	] as const;
	return glyph.rows.flatMap((bits, row) =>
		bits
			.split("")
			.flatMap((_, col) =>
				filled(col, row)
					? sides.flatMap(([dx, dy, x1, y1, x2, y2]) =>
							filled(col + dx, row + dy)
								? []
								: [{ col, row, x1: col + x1, y1: row + y1, x2: col + x2, y2: row + y2 }],
						)
					: [],
			),
	);
}
export const WORDMARK_OUTLINE = outlineOf(WORDMARK);

/** C and cursor logo, on the original stamp grid so press growth keeps its scale. */
export const MARK: Glyph = {
	width: 15,
	height: 15,
	rows: [
		"111111111111111",
		"111111111111111",
		"111111111111111",
		"111000000000000",
		"111000000000000",
		"111000000000000",
		"111000000000111",
		"111000000000111",
		"111000000000111",
		"111000000000000",
		"111000000000000",
		"111000000000000",
		"111111111111111",
		"111111111111111",
		"111111111111111",
	],
};

/** A heart, drawn inline in copy at text height. */
export const HEART: Glyph = {
	width: 7,
	height: 6,
	rows: ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"],
};
