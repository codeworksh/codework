import { createDinoArcade } from "./dino";
import { createInvadersArcade } from "./invaders";

export const ARCADE_MODES = ["low", "mid", "hard"] as const;
export type ArcadeMode = (typeof ARCADE_MODES)[number];

/** How long an idle board stays up before the slider moves on. */
export const SLIDE_HOLD_MS = 16_000;

/** One pixel of a sprite in grid-cell units (`PITCH = 7px`, so `0.36 * 7 ≈ 2.5px`). */
export const SPRITE_UNIT = 0.36;

export type SpeechBubble = {
	text: string;
	/** Grid cell the tail points at. */
	x: number;
	y: number;
	alpha: number;
};

export type ArcadeSpriteKind =
	| "dino-jump"
	| "dino-run-a"
	| "dino-run-b"
	| "dino-duck-a"
	| "dino-duck-b"
	| "dino-crash"
	| "cactus-small"
	| "cactus-tall"
	| "ptero-up"
	| "ptero-down"
	| "star-face"
	| "star-edge"
	| "invader-squid-a"
	| "invader-squid-b"
	| "invader-crab-a"
	| "invader-crab-b"
	| "invader-octo-a"
	| "invader-octo-b"
	| "invader-ufo"
	| "ship-intact"
	| "ship-hit";

export type ArcadeSprite = {
	kind: ArcadeSpriteKind;
	/** Left edge in grid cells. */
	x: number;
	/** Top edge in grid cells. */
	y: number;
	/** Width in sprite pixels. */
	width: number;
	/** Height in sprite pixels. */
	height: number;
	alpha: number;
};

const SPRITE_ROWS: Record<ArcadeSpriteKind, readonly string[]> = {
	"dino-jump": [
		"........#######.",
		".......#########",
		".......##.######",
		".......#########",
		".......#####....",
		".......########.",
		"#.....######....",
		"##...########...",
		"###.###########.",
		"############..#.",
		".###########....",
		"..#########.....",
		"...#######......",
		"....##..##......",
		"....#....#......",
		"....##...##.....",
	],
	"dino-run-a": [
		"........#######.",
		".......#########",
		".......##.######",
		".......#########",
		".......#####....",
		".......########.",
		"#.....######....",
		"##...########...",
		"###.###########.",
		"############..#.",
		".###########....",
		"..#########.....",
		"...#######......",
		"....##..###.....",
		"....#...........",
		"....##..........",
	],
	"dino-run-b": [
		"........#######.",
		".......#########",
		".......##.######",
		".......#########",
		".......#####....",
		".......########.",
		"#.....######....",
		"##...########...",
		"###.###########.",
		"############..#.",
		".###########....",
		"..#########.....",
		"...#######......",
		"....###..##.....",
		".........#......",
		".........##.....",
	],
	"dino-duck-a": [
		"............#######.",
		"#..........#########",
		"##..#########.######",
		"####################",
		".############.#####.",
		"..##########..#####.",
		"...########...#.....",
		"....##..###.........",
		"....#...............",
		"....##..............",
	],
	"dino-duck-b": [
		"............#######.",
		"#..........#########",
		"##..#########.######",
		"####################",
		".############.#####.",
		"..##########..#####.",
		"...########...#.....",
		"....###..##.........",
		".........#..........",
		".........##.........",
	],
	"dino-crash": [
		"........#######.",
		".......#########",
		".......#...#####",
		".......#.#.#####",
		".......#...#....",
		".......########.",
		"#.....######....",
		"##...########...",
		"###.###########.",
		"############..#.",
		".###########....",
		"..#########.....",
		"...#######......",
		"....##..##......",
		"....#....#......",
		"....##...##.....",
	],
	"cactus-small": [
		"...##...",
		"...##...",
		"#..##...",
		"#..##..#",
		"#..##..#",
		"#####..#",
		".######.",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
	],
	"cactus-tall": [
		"....##....",
		"....##....",
		"#...##....",
		"##..##..#.",
		"##..##..##",
		"##..##..##",
		"######..##",
		".#####..##",
		"....######",
		"....#####.",
		"....##....",
		"....##....",
		"....##....",
		"....##....",
		"....##....",
		"....##....",
	],
	"ptero-up": [
		"......##........",
		".....###........",
		"....####........",
		"..###.#####.....",
		".##########.....",
		"############....",
		"...##########...",
		".....##########.",
		"......####..##..",
		"................",
		"................",
		"................",
	],
	"ptero-down": [
		"................",
		"................",
		"................",
		"..###...........",
		".#####..........",
		"############....",
		"...#############",
		".....#########..",
		".....####...##..",
		".....###........",
		"......##........",
		"......#.........",
	],
	"star-face": ["...##...", "...##...", "..####..", "########", "########", "..####..", "...##...", "...##..."],
	"star-edge": ["........", "...##...", "...##...", "..####..", "..####..", "...##...", "...##...", "........"],
	"invader-squid-a": ["...##...", "..####..", ".######.", "##.##.##", "########", "..#..#..", ".#.##.#.", "#.#..#.#"],
	"invader-squid-b": ["...##...", "..####..", ".######.", "##.##.##", "########", ".#.##.#.", "#......#", ".#....#."],
	"invader-crab-a": [
		"..#.....#..",
		"...#...#...",
		"..#######..",
		".##.###.##.",
		"###########",
		"#.#######.#",
		"#.#.....#.#",
		"...##.##...",
	],
	"invader-crab-b": [
		"..#.....#..",
		"#..#...#..#",
		"#.#######.#",
		"###.###.###",
		"###########",
		".#########.",
		"..#.....#..",
		".#.......#.",
	],
	"invader-octo-a": [
		"....####....",
		".##########.",
		"############",
		"###..##..###",
		"############",
		"...##..##...",
		"..##.##.##..",
		"##........##",
	],
	"invader-octo-b": [
		"....####....",
		".##########.",
		"############",
		"###..##..###",
		"############",
		"..###..###..",
		".##..##..##.",
		"..##....##..",
	],
	"invader-ufo": [
		"....######....",
		"..##########..",
		".############.",
		"##.##.##.##.##",
		"##############",
		"..###....###..",
	],
	"ship-intact": [
		"......#......",
		".....###.....",
		".....###.....",
		".#..#####..#.",
		"#.#########.#",
		"#############",
		"#############",
		"###..###..###",
	],
	"ship-hit": [
		"..#...#...#..",
		"....#...#....",
		".#...###...#.",
		"...##.#.##...",
		"#..#######..#",
		".###.###.###.",
		"..#..###..#..",
		"#...#...#...#",
	],
};

/** Merges each row's filled runs into one SVG path so each sprite paints in a single fill. */
function traceRows(rows: readonly string[]): string {
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

export const SPRITE_PATHS = Object.fromEntries(
	(Object.entries(SPRITE_ROWS) as [ArcadeSpriteKind, readonly string[]][]).map(([kind, rows]) => [
		kind,
		traceRows(rows),
	]),
) as Record<ArcadeSpriteKind, string>;

/**
 * Shared interface for empty-session grid games so the slider can host and
 * switch between them cleanly.
 */
export type GridArcade = {
	resize(nextCols: number, nextRows: number): void;
	takeControl(): void;
	releaseControl(): void;
	keyDown(key: string, repeat: boolean): boolean;
	keyUp(key: string): void;
	blur(): void;
	pointerDown(xRatio: number): void;
	setMode(next: ArcadeMode): void;
	mode(): ArcadeMode;
	controlled(): boolean;
	score(): number;
	highScore(): number;
	lives(): number;
	gameOver(): boolean;
	step(dt: number): void;
	speechBubble(): SpeechBubble | null;
	sprites(): ArcadeSprite[];
	fade(): number;
	stamp(out: Float32Array, stampCols: number, stampRows: number): void;
};

export type GridGame = {
	id: string;
	label: string;
	playLabel: string;
	playHint: string;
	overHint: string;
	idleDim: number;
	lives: boolean;
	create: () => GridArcade;
};

/**
 * Games the empty-session slider rotates through. Push another entry to add
 * one — the track, dots, and take-control path all follow this list.
 */
export const GRID_GAMES: readonly GridGame[] = [
	{
		id: "dino",
		label: "dino",
		playLabel: "Dino runner. Space or Up to jump, Down to duck, Escape to release.",
		playHint: "Space / ↑ / tap to jump · ↓ to duck",
		overHint: "Space or tap to restart",
		idleDim: 0.55,
		lives: false,
		create: createDinoArcade,
	},
	{
		id: "invaders",
		label: "invaders",
		playLabel: "Space Invaders. Left and Right or A and D to move, Space or Up to fire, Escape to release.",
		playHint: "← / → or A / D to move · Space / ↑ / tap to fire",
		overHint: "Space or tap to restart",
		idleDim: 0.5,
		lives: true,
		create: createInvadersArcade,
	},
];

/**
 * Next stop on the idle slider. Walks to the end and back so a wrap never
 * has to jump the track the long way around.
 */
export function stepSlider(index: number, dir: 1 | -1, count: number): { index: number; dir: 1 | -1 } {
	if (count <= 1) return { index: 0, dir: 1 };
	const next = index + dir;
	if (next >= count) return { index: count - 2, dir: -1 };
	if (next < 0) return { index: 1, dir: 1 };
	return { index: next, dir };
}
