/** The pixel terminal mascot, 16×12: its outline with an empty screen, and the corner glow around it. */
const SHELL = [
	"..############..",
	".##..........##.",
	".#............#.",
	".#............#.",
	".#............#.",
	".#............#.",
	".#............#.",
	".#............#.",
	".##..........##.",
	"..############..",
	"......####......",
	"....########....",
] as const;

export const GLOW = [
	"#.#..........#.#",
	"................",
	"#..............#",
	"................",
	"................",
	"................",
	"................",
	"#..............#",
	"................",
	"#.#..........#.#",
	"................",
	"..#..........#..",
] as const;

export const TERMINAL_WIDTH = SHELL[0].length;
export const TERMINAL_HEIGHT = SHELL.length;

/** The terminal with `glyph` drawn on its screen, its top-left cell at (`x`, `y`). */
export function onScreen(glyph: readonly string[], x: number, y: number): string[] {
	return SHELL.map((row, dy) => {
		const line = glyph[dy - y];
		if (line === undefined) return row;
		return row
			.split("")
			.map((cell, dx) => (line[dx - x] === "#" ? "#" : cell))
			.join("");
	});
}

/** Merges each row's filled runs into one rect so the path stays short. */
export function spritePath(rows: readonly string[]) {
	let path = "";
	rows.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			if (row[x] !== "#") {
				x += 1;
				continue;
			}
			let run = 1;
			while (row[x + run] === "#") run += 1;
			path += `M${x} ${y}h${run}v1h-${run}z`;
			x += run;
		}
	});
	return path;
}
