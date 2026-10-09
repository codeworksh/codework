import { useEffect, useRef } from "react";
import { Chase, chaseCount, type Pellet } from "./chase";
import { THEME_EVENT } from "./theme";
import { DEPTH, MARK, WORDMARK, WORDMARK_OUTLINE, type Ink } from "./wordmark";

/**
 * The hero's pixel field: drifting dithered noise on the wordmark's grid, a glow that follows
 * the pointer, a tile-eating logo character, and the mark stamped wherever you click. 'hero' draws the
 * word into the field; 'field' is the bare texture for the footer.
 */

type Palette = Record<Ink | "bg" | "tile" | "grid", string>;

/** Mixes two #rrggbb colours, `t` of the way from a to b. */
const mixHex = (a: string, b: string, t: number) =>
	`#${[1, 3, 5]
		.map((i) => {
			const [from, to] = [parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16)];
			return Math.round(from + (to - from) * t)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;

function readPalette(): Palette {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string) => style.getPropertyValue(`--t-field-${name}`).trim();
	return {
		bg: token("bg"),
		grid: mixHex(token("bg"), token("dim"), 0.22),
		tile: mixHex(token("dim"), token("lit"), TILE_LIFT),
		dim: token("dim"),
		mid: token("mid"),
		lit: token("lit"),
		hover: token("hover"),
		crest: token("crest"),
	};
}

/** Classic 8x8 ordered dither matrix, 0..63. */
const BAYER = [
	0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
	54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
	61, 29, 53, 21,
];

const NOISE_SIZE = 128;
/** Grid cells per unit of noise: how big the drifting blobs read. */
const CELLS_PER_NOISE = 9;
/** Each faint grid square contains two by two field pixels. */
const GRID_CELLS = 2;
/** Pointer reach, in grid cells. */
const CURSOR_CELLS = 12;
/** Density of the bare field, which has no vignette to shape it. */
const FIELD_DENSITY = 0.3;
/** How close (css px) the pointer may come to copy before its glow fades out. */
const HUSH_REACH = 96;
const CLEAR_CURVE = 3;
/** Footer copy keeps the field this far (css px) clear of itself. */
const CLEAR_REACH = 150;

/** A held press grows the stamp: seconds to full charge, and cells per mark pixel. */
const CHARGE_TIME = 1.1;
const CHARGE_FROM = 0.45;
const CHARGE_GROWTH = 1.6;

/** The word is cut in left to right, each cell flashing its crest ink as it lands. */
const ENTRANCE_SWEEP = 0.8;
const ENTRANCE_SCATTER = 0.35;
const ENTRANCE_FLASH = 0.16;

/**
 * File-extension tiles across the hero: bigger pixels, a whole number of cells, lit and dithered
 * like the rest. Tiles start at TILE_W x TILE_H cells and grow on small screens so the label stays legible.
 */
const EXTENSIONS = [
	".py",
	".js",
	".ts",
	".java",
	".cs",
	".cpp",
	".go",
	".rs",
	".rb",
	".php",
	".c",
	".kt",
	".swift",
	".scala",
	".dart",
	".lua",
	".r",
	".jl",
	".hs",
	".ex",
	".erl",
	".clj",
	".ml",
	".elm",
	".zig",
	".nim",
	".sh",
	".sql",
	".sol",
	".mojo",
	".gleam",
	".asm",
];
/** Tiles walk the list in steps of this, which must not divide its length, so every extension shows before one repeats. */
const EXTENSION_STEP = 7;
const TILE_W = 4;
const TILE_H = 2;
/** How far a resting tile's ink is lifted from dim toward lit, so its label stands out from the field. */
const TILE_LIFT = 0.1;
/** Target minimum tile width, in css px, rounded to the field grid. */
const TILE_MIN_CSS = 40;
/** Share of the eligible slots that hold a tile, so the corners stay scattered. Small screens use a denser share of their fewer available slots. */
const TILE_ODDS = 0.16;
/** Css px a tile keeps clear of copy and controls. */
const TILE_CLEARANCE = 16;
/** A tile is one pixel standing in for many, so the drift lights it more often than a single cell. */
const TILE_GAIN = 2.4;

/** The slotless footer field lines up with the hero's lattice. */
const SLOT_INSET = 48;
const SLOT_FRACTION = 0.88;
const SLOT_MAX = 896;

type Ping = { x: number; y: number; born: number; from: number; to: number; life: number };
type Charge = { x: number; y: number; start: number };
type Glow = { x: number; y: number; strength: number; reach: number };
type Stamp = { x: number; y: number; cellPx: number; amp: number };
/** Extension tiles appear and disappear with the field on every screen size. */
type Tile = { col: number; row: number; w: number; h: number; shade: number; ext: string };

function lcg(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/** White noise box-blurred into soft blobs, then stretched back to 0..1. */
function buildNoise(seed: number) {
	const size = NOISE_SIZE;
	const random = lcg(seed);
	let field = new Float32Array(size * size).map(random);
	for (let pass = 0; pass < 2; pass++) {
		const next = new Float32Array(size * size);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				let sum = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++)
						sum += field[((y + dy + size) % size) * size + ((x + dx + size) % size)]!;
				}
				next[y * size + x] = sum / 9;
			}
		}
		field = next;
	}
	let min = Infinity;
	let max = -Infinity;
	for (const v of field) {
		min = Math.min(min, v);
		max = Math.max(max, v);
	}
	return field.map((v) => (v - min) / (max - min || 1));
}

function sample(field: Float32Array, x: number, y: number) {
	const size = NOISE_SIZE;
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const fx = x - xi;
	const fy = y - yi;
	const x0 = ((xi % size) + size) % size;
	const y0 = ((yi % size) + size) % size;
	const x1 = (x0 + 1) % size;
	const y1 = (y0 + 1) % size;
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);
	const a = field[y0 * size + x0]!;
	const b = field[y0 * size + x1]!;
	const c = field[y1 * size + x0]!;
	const d = field[y1 * size + x1]!;
	return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

export function Field({ variant = "hero", onPainted }: { variant?: "hero" | "field"; onPainted?: () => void }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const painted = useRef(onPainted);
	painted.current = onPainted;

	useEffect(() => {
		const canvas = canvasRef.current;
		const host = canvas?.parentElement;
		const ctx = canvas?.getContext("2d", { alpha: false });
		if (!canvas || !host || !ctx) return;

		const isHero = variant === "hero";
		const glyph = WORDMARK;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
		const noise = buildNoise(0x7fb4dc);
		const jitter = new Float32Array(64 * 64).map(lcg(0x0a1f14));
		// Only a few dozen tiles fit, so each visit starts the walk somewhere else in the list.
		const firstExtension = Math.floor(Math.random() * EXTENSIONS.length);
		let palette = readPalette();

		// Device-pixel geometry. One grid for everything, anchored on the wordmark slot: the
		// word occupies cells 0..width, 0..height and the field runs into negative indices around it.
		let dpr = 1;
		let width = 0;
		let height = 0;
		let wmX = 0;
		let wmY = 0;
		let cell = 10;
		let cMin = 0;
		let rMin = 0;
		let cols = 0;
		let rows = 0;
		let ramp = new Float32Array(0);
		let tiles: Tile[] = [];
		/** Cells a tile sits on, which the plain field leaves empty. */
		let covered = new Uint8Array(0);

		const quiet = isHero
			? [
					...document.querySelectorAll<HTMLElement>("header a, header button"),
					...[...document.querySelectorAll<HTMLElement>("[data-hero-quiet]")].flatMap(
						(el) => [...el.children] as HTMLElement[],
					),
				]
			: [...host.parentElement!.querySelectorAll<HTMLElement>("[data-quiet]")];
		const slot = isHero ? document.querySelector<HTMLElement>("[data-hero-wordmark]") : null;

		const pointer = { x: -1e4, y: -1e4 };
		let chasers: Chase[] = [];
		const eaten = new Map<string, number>();
		let pellets: Pellet[] = [];
		let strength = 0;
		let targetStrength = 0;
		let pings: Ping[] = [];
		let holding: Charge | null = null;
		let wordPress = false;
		let visible = true;
		let entrance: number | null = isHero && !reducedMotion ? null : -Infinity;

		const onWord = (x: number, y: number) =>
			isHero && x >= wmX && y >= wmY && x < wmX + glyph.width * cell && y < wmY + glyph.height * cell;
		const onControl = (target: EventTarget | null) =>
			target instanceof Element && target.closest("a, button, input, header, [data-no-stamp]") !== null;
		const chargeOf = (now: number, start: number) => Math.min((now - start) / 1000 / CHARGE_TIME, 1);

		const launch = (x: number, y: number, charge: number, now: number) => {
			const from = CHARGE_FROM + CHARGE_GROWTH * charge;
			pings = [
				...pings.slice(-3),
				{
					x,
					y,
					born: now,
					from,
					to: (from + 1 + 3.2 * charge) * (0.92 + Math.random() * 0.16),
					life: (0.65 + 0.55 * charge) * (0.92 + Math.random() * 0.16),
				},
			];
		};

		/** 0 beside text or controls, 1 well away from them. */
		const nearest = (list: HTMLElement[], x: number, y: number) => {
			let best = Infinity;
			for (const el of list) {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue;
				const dx = Math.max(r.left - x, 0, x - r.right);
				const dy = Math.max(r.top - y, 0, y - r.bottom);
				best = Math.min(best, Math.hypot(dx, dy));
			}
			return best;
		};
		const reach = isHero ? HUSH_REACH : CLEAR_REACH;
		const strengthAt = (x: number, y: number) => {
			const dist = nearest(quiet, x, y);
			return dist >= reach ? 1 : (dist / reach) ** CLEAR_CURVE;
		};

		const measure = () => {
			const box = host.getBoundingClientRect();
			if (box.width < 1 || box.height < 1) return false;
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			const nextWidth = Math.round(box.width * dpr);
			const nextHeight = Math.round(box.height * dpr);
			// Assigning canvas.width wipes the buffer, so only do it when the size changed.
			if (nextWidth !== width || nextHeight !== height) {
				width = canvas.width = nextWidth;
				height = canvas.height = nextHeight;
			}

			const slotBox = slot?.getBoundingClientRect();
			const slotWidth = (slotBox?.width ?? Math.min(SLOT_FRACTION * (box.width - SLOT_INSET), SLOT_MAX)) * dpr;
			wmX = slotBox ? (slotBox.left - box.left) * dpr : (width - slotWidth) / 2;
			wmY = slotBox ? (slotBox.top - box.top) * dpr : 0;
			cell = slotWidth / glyph.width;

			cMin = -Math.ceil(wmX / cell) - 1;
			rMin = -Math.ceil(wmY / cell) - 1;
			cols = Math.ceil((width - wmX) / cell) - cMin + 1;
			rows = Math.ceil((height - wmY) / cell) - rMin + 1;

			// Footer copy is kept clear of the field; the hero clears its centre with a vignette instead.
			const quietBoxes = isHero
				? []
				: quiet
						.map((el) => el.getBoundingClientRect())
						.filter((r) => r.width >= 1 && r.height >= 1)
						.map((r) => ({
							l: (r.left - box.left) * dpr,
							t: (r.top - box.top) * dpr,
							r: (r.right - box.left) * dpr,
							b: (r.bottom - box.top) * dpr,
						}));
			const clearOf = (x: number, y: number) => {
				let best = Infinity;
				for (const q of quietBoxes)
					best = Math.min(best, Math.hypot(Math.max(q.l - x, 0, x - q.r), Math.max(q.t - y, 0, y - q.b)));
				return best >= CLEAR_REACH * dpr ? 1 : (best / (CLEAR_REACH * dpr)) ** CLEAR_CURVE;
			};

			ramp = new Float32Array(cols * rows);
			for (let r = 0; r < rows; r++) {
				const y = wmY + (rMin + r + 0.5) * cell;
				const ny = (y / height) * 2 - 1;
				const clear = isHero ? Math.min(1, Math.max(0.16, (y / dpr - 24) / 130)) : FIELD_DENSITY;
				for (let c = 0; c < cols; c++) {
					const x = wmX + (cMin + c + 0.5) * cell;
					const nx = (x / width) * 2 - 1;
					const eased = Math.min(1, Math.max(0, (Math.sqrt(nx * nx + ny * ny * 0.82) - 0.42) / 0.85));
					ramp[r * cols + c] = (isHero ? eased * eased : 1) * clear * clearOf(x, y);
				}
			}
			layTiles(box);
			const obstacles = [...quiet, ...(slot ? [slot] : [])].map((el) => {
				const rect = el.getBoundingClientRect();
				// Mobile copy wrappers span the screen; keep their side gutters traversable.
				const gutter = box.width < 640 && !el.closest("header") ? 16 : 0;
				return {
					left: rect.left - box.left + gutter,
					top: rect.top - box.top,
					right: rect.right - box.left - gutter,
					bottom: rect.bottom - box.top,
				};
			});
			eaten.clear();
			const starts = [
				{ x: 30, y: 90 },
				{ x: box.width - 30, y: box.height - 30 },
				{ x: box.width - 30, y: 90 },
				{ x: 30, y: box.height - 30 },
				{ x: box.width / 2, y: 90 },
			];
			chasers =
				isHero && !reducedMotion
					? starts
							.slice(0, chaseCount(box.width))
							.map((start) => new Chase(box.width, box.height, obstacles, start, eaten))
					: [];
			pellets = tiles.map((tile) => ({
				id: `${tile.col}:${tile.row}`,
				x: (wmX + (tile.col + tile.w / 2) * cell) / dpr,
				y: (wmY + (tile.row + tile.h / 2) * cell) / dpr,
			}));
			return true;
		};

		/** Tiles on a lattice aligned to the word's grid, scattered through the clear spaces. */
		const layTiles = (box: DOMRect) => {
			tiles = [];
			covered = new Uint8Array(cols * rows);
			if (!isHero) return;
			const small = box.width < 640;
			const w = Math.max(TILE_W, Math.round((TILE_MIN_CSS * dpr) / cell));
			const h = Math.max(TILE_H, Math.round((w * TILE_H) / TILE_W));
			const count = chaseCount(box.width);
			const odds = Math.min(0.65, (small ? 0.3 : TILE_ODDS) * Math.sqrt(count));
			const slots: { col: number; row: number; shade: number; rank: number }[] = [];
			const stepX = w + 1;
			const stepY = h + 1;
			// Anchor the two sides to the canvas edges, so changing the word's width cannot empty a corner.
			const firstCol = Math.ceil(-wmX / cell);
			const lastCol = Math.floor((width - wmX) / cell) - w;
			const middleCol = (firstCol + lastCol) / 2;
			const tileCols: number[] = [];
			for (let col = firstCol; col <= middleCol; col += stepX) tileCols.push(col);
			for (let col = lastCol; col > middleCol; col -= stepX) tileCols.push(col);
			for (let row = Math.ceil(rMin / stepY) * stepY; row + h <= rMin + rows; row += stepY) {
				for (const col of tileCols) {
					if (row < glyph.height && row + h > 0 && col < glyph.width && col + w > 0) continue;
					const x = wmX + (col + w / 2) * cell;
					const y = wmY + (row + h / 2) * cell;

					const shade = Math.max(0.22, ramp[(row + (h >> 1) - rMin) * cols + (col + (w >> 1) - cMin)] ?? 0);
					if (jitter[(row * 29 + col * 13) & 4095]! > odds) continue;
					const halfW = (w * cell) / 2 / dpr + TILE_CLEARANCE;
					const halfH = (h * cell) / 2 / dpr + TILE_CLEARANCE;
					if (nearest(quiet, box.left + x / dpr, box.top + y / dpr) < Math.hypot(halfW, halfH)) continue;
					slots.push({ col, row, shade, rank: jitter[(row * 29 + col * 13) & 4095]! });
				}
			}
			// Sparse tiles throughout the clear spaces, with a smaller mobile budget.
			const kept = slots.sort((a, b) => a.rank - b.rank).slice(0, count * (small ? 16 : 24));
			for (const { col, row, shade } of kept) {
				tiles.push({
					col,
					row,
					w,
					h,
					shade,
					ext: EXTENSIONS[(firstExtension + tiles.length * EXTENSION_STEP) % EXTENSIONS.length]!,
				});
				for (let r = row; r < row + h; r++)
					covered.fill(1, (r - rMin) * cols + col - cMin, (r - rMin) * cols + col - cMin + w);
			}
		};

		const draw = (time: number) => {
			// Start when pixels are ready, rather than spending the entrance on layout work.
			entrance ??= time;
			const t = reducedMotion ? 0 : time / 1000;
			const age = (time - entrance) / 1000;
			const entering = age < ENTRANCE_SWEEP + ENTRANCE_SCATTER + ENTRANCE_FLASH;

			const targets = new Set(chasers.flatMap((chase) => (chase.targetId ? [chase.targetId] : [])));
			if (!entering)
				for (const chase of chasers) {
					if (chase.targetId) targets.delete(chase.targetId);
					chase.update(t, pellets, targets);
					if (chase.targetId) targets.add(chase.targetId);
				}
			strength += (targetStrength - strength) * 0.3;

			ctx.fillStyle = palette.bg;
			ctx.fillRect(0, 0, width, height);

			if (isHero) {
				ctx.strokeStyle = palette.grid;
				ctx.lineWidth = 1;
				ctx.beginPath();
				for (let col = Math.ceil(cMin / GRID_CELLS) * GRID_CELLS; col < cMin + cols; col += GRID_CELLS) {
					const x = Math.round(wmX + col * cell) + 0.5;
					ctx.moveTo(x, 0);
					ctx.lineTo(x, height);
				}
				for (let row = Math.ceil(rMin / GRID_CELLS) * GRID_CELLS; row < rMin + rows; row += GRID_CELLS) {
					const y = Math.round(wmY + row * cell) + 0.5;
					ctx.moveTo(0, y);
					ctx.lineTo(width, y);
				}
				ctx.stroke();
			}

			const reachOf = (level: number) => CURSOR_CELLS * cell * (0.45 + 0.55 * level);
			const glows: Glow[] = [];
			if (strength > 0.01) glows.push({ ...pointer, strength, reach: reachOf(strength) });
			if (!entering)
				for (const chase of chasers)
					glows.push({ x: chase.x * dpr, y: chase.y * dpr, strength: 0.25, reach: 36 * dpr });
			const glowAt = (cx: number, cy: number) => {
				let amount = 0;
				for (const glow of glows) {
					const dist = Math.hypot(cx - glow.x, cy - glow.y);
					if (dist < glow.reach) amount = Math.max(amount, (1 - dist / glow.reach) ** 2 * glow.strength);
				}
				return amount;
			};

			pings = pings.filter((ping) => (time - ping.born) / 1000 < ping.life);
			const stamps: Stamp[] = pings.map((ping) => {
				const life = (time - ping.born) / 1000 / ping.life;
				const grow = 1 - (1 - life) ** 3;
				return {
					x: ping.x,
					y: ping.y,
					cellPx: cell * (ping.from + (ping.to - ping.from) * grow),
					amp: (1 - life) ** 1.7,
				};
			});
			if (holding)
				stamps.push({
					x: holding.x,
					y: holding.y,
					cellPx: cell * (CHARGE_FROM + CHARGE_GROWTH * chargeOf(time, holding.start)),
					amp: 0.9,
				});
			const stampAt = (cx: number, cy: number) => {
				let amp = 0;
				for (const stamp of stamps) {
					const lx = Math.floor((cx - stamp.x) / stamp.cellPx + MARK.width / 2);
					const ly = Math.floor((cy - stamp.y) / stamp.cellPx + MARK.height / 2);
					if (MARK.rows[ly]?.[lx] === "1") amp = Math.max(amp, stamp.amp);
				}
				return amp;
			};

			/** How lit a spot of the field is, and how much of that is the glow or a stamp. */
			const light = (col: number, row: number, shade: number, cx: number, cy: number, gain = 1) => {
				let lum = 0;
				if (shade > 0.002) {
					const u = col / CELLS_PER_NOISE;
					const v = row / CELLS_PER_NOISE;
					const base =
						0.6 * sample(noise, u + t * 0.14, v - t * 0.055) +
						0.4 * sample(noise, u * 0.55 - t * 0.08, v * 0.55 + t * 0.06);
					const twinkle =
						0.5 + 0.5 * Math.sin(t * 1.1 + jitter[(Math.floor(row) * 37 + Math.floor(col) * 11) & 4095]! * 6.283);
					lum = shade * (0.3 + 0.52 * base * base + 0.18 * twinkle) * 0.62 * gain;
				}
				const glow = glows.length > 0 ? glowAt(cx, cy) : 0;
				const wave = stamps.length > 0 ? stampAt(cx, cy) : 0;
				return { lum: lum + glow * 0.6 + wave * 1.15, heat: Math.max(glow, wave) };
			};
			// Bayer alone reads as a lattice at this density; a fixed per-cell offset scatters it.
			const threshold = (col: number, row: number) =>
				0.78 * ((BAYER[(row & 7) * 8 + (col & 7)]! + 0.5) / 64) + 0.22 * jitter[(row & 63) * 64 + (col & 63)]!;
			const inkOf = (heat: number) => (heat > 0.34 ? palette.lit : heat > 0.1 ? palette.mid : palette.dim);

			// The hero rests on the grid alone; small cells only draw the interactive logo stamps.
			for (let r = 0; r < rows && (!isHero || stamps.length > 0); r++) {
				const row = rMin + r;
				const yTop = wmY + row * cell;
				const y = Math.round(yTop);
				const cellH = Math.round(yTop + cell) - y;
				const cy = yTop + cell / 2;
				for (let c = 0; c < cols; c++) {
					const col = cMin + c;
					if (covered[r * cols + c] === 1) continue;
					if (isHero && glyph.rows[row]?.[col] === "1") continue;
					const xLeft = wmX + col * cell;
					const wave = isHero ? stampAt(xLeft + cell / 2, cy) : 0;
					const { lum, heat } = isHero
						? { lum: wave * 1.15, heat: wave }
						: light(col, row, ramp[r * cols + c]!, xLeft + cell / 2, cy);
					if (lum <= threshold(col, row)) continue;
					ctx.fillStyle = inkOf(heat);
					const x = Math.round(xLeft);
					ctx.fillRect(x, y, Math.round(xLeft + cell) - x, cellH);
				}
			}

			// Extension tiles: one big pixel each, lit by the same light, the label cut out of the ink.
			if (tiles.length > 0) {
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.font = `700 ${Math.round(tiles[0]!.h * cell * 0.5)}px "JetBrains Mono Variable", monospace`;
			}
			for (const tile of tiles) {
				if (eaten.has(`${tile.col}:${tile.row}`)) continue;
				const x = Math.round(wmX + tile.col * cell);
				const y = Math.round(wmY + tile.row * cell);
				const cx = wmX + (tile.col + tile.w / 2) * cell;
				const cy = wmY + (tile.row + tile.h / 2) * cell;
				const { lum, heat } = light(tile.col + tile.w / 2, tile.row + tile.h / 2, tile.shade, cx, cy, TILE_GAIN);
				const floor = threshold(tile.col, tile.row);
				if (lum <= floor && !targets.has(`${tile.col}:${tile.row}`)) continue;
				// A tile well past its threshold rests a shade brighter, so its label reads.
				const ink = inkOf(Math.max(heat, (lum - floor) * 0.5, targets.has(`${tile.col}:${tile.row}`) ? 0.15 : 0));
				ctx.fillStyle = ink === palette.dim ? palette.tile : ink;
				ctx.fillRect(
					x,
					y,
					Math.round(wmX + (tile.col + tile.w) * cell) - x,
					Math.round(wmY + (tile.row + tile.h) * cell) - y,
				);
				ctx.fillStyle = palette.bg;
				ctx.fillText(tile.ext, cx, cy, tile.w * cell * 0.9);
			}

			// Outline echoes reveal with the same cells as the solid word.
			const landsAt = (col: number, row: number) =>
				(col / glyph.width) * ENTRANCE_SWEEP + jitter[(row & 63) * 64 + (col & 63)]! * ENTRANCE_SCATTER;
			if (isHero) {
				ctx.lineWidth = Math.max(1, cell * 0.08);
				for (const { offset, ink } of DEPTH) {
					ctx.strokeStyle = palette[ink];
					ctx.beginPath();
					for (const edge of WORDMARK_OUTLINE) {
						if (entering && age < landsAt(edge.col, edge.row)) continue;
						ctx.moveTo(wmX + (edge.x1 + offset) * cell, wmY + (edge.y1 + offset) * cell);
						ctx.lineTo(wmX + (edge.x2 + offset) * cell, wmY + (edge.y2 + offset) * cell);
					}
					ctx.stroke();
				}
			}

			// Solid word, lifted by a stamp or glow passing over it.
			for (let row = 0; isHero && row < glyph.height; row++) {
				const bits = glyph.rows[row]!;
				const yTop = wmY + row * cell;
				const y = Math.round(yTop);
				const rowHeight = Math.round(yTop + cell) - y;
				for (let col = 0; col < glyph.width; col++) {
					if (bits[col] !== "1") continue;
					const xLeft = wmX + col * cell;
					const cx = xLeft + cell / 2;
					const cy = yTop + cell / 2;
					let ink = palette.lit;
					if (entering) {
						const arrival = landsAt(col, row);
						if (age < arrival) continue;
						if (age < arrival + ENTRANCE_FLASH) ink = palette.crest;
					}
					const lift = Math.max(stamps.length > 0 ? stampAt(cx, cy) : 0, glows.length > 0 ? glowAt(cx, cy) : 0);
					if (lift > 0.45) ink = palette.crest;
					else if (lift > 0.12) ink = palette.hover;
					ctx.fillStyle = ink;
					const x = Math.round(xLeft);
					ctx.fillRect(x, y, Math.round(xLeft + cell) - x, rowHeight);
				}
			}

			if (!entering) for (const chase of chasers) chase.draw(ctx, t, dpr, palette.lit, palette.crest);

			if (painted.current) {
				painted.current();
				painted.current = undefined;
			}
			canvas.dataset.painted = "true";
		};

		let frame = 0;
		let lastDraw = 0;
		const loop = (time: number) => {
			frame = requestAnimationFrame(loop);
			if (time - lastDraw < 25) return;
			lastDraw = time;
			draw(time);
		};

		const locate = (event: PointerEvent) => {
			const box = host.getBoundingClientRect();
			return {
				inside:
					event.clientX >= box.left &&
					event.clientX <= box.right &&
					event.clientY >= box.top &&
					event.clientY <= box.bottom,
				x: (event.clientX - box.left) * dpr,
				y: (event.clientY - box.top) * dpr,
			};
		};

		const onPointerMove = (event: PointerEvent) => {
			if (!visible) return;
			const { inside, x, y } = locate(event);
			if (!holding) targetStrength = inside ? strengthAt(event.clientX, event.clientY) : 0;
			host.style.cursor = inside && onWord(x, y) && !reducedMotion ? "pointer" : "";
			if (!inside) return;
			pointer.x = x;
			pointer.y = y;
		};

		const onPointerDown = (event: PointerEvent) => {
			if (!visible || reducedMotion) return;
			const { inside, x, y } = locate(event);
			if (!inside || onControl(event.target)) return;
			pointer.x = x;
			pointer.y = y;
			if (onWord(x, y)) {
				wordPress = true;
				return;
			}
			targetStrength = 0;
			holding = { x, y, start: performance.now() };
		};

		const onPointerUp = (event: PointerEvent) => {
			const { inside, x, y } = locate(event);
			if (wordPress) {
				wordPress = false;
				// Pressing the word cuts it in again.
				if (inside && onWord(x, y)) entrance = performance.now();
				return;
			}
			if (!holding) return;
			if (finePointer) targetStrength = inside ? strengthAt(event.clientX, event.clientY) : 0;
			const now = performance.now();
			launch(holding.x, holding.y, chargeOf(now, holding.start), now);
			holding = null;
		};

		const onPointerCancel = () => {
			holding = null;
			wordPress = false;
		};

		let drawing = false;
		const start = () => {
			if (drawing) return;
			drawing = true;
			if (reducedMotion) draw(0);
			else frame = requestAnimationFrame(loop);
		};
		if (measure()) start();

		// Pause while off screen.
		const visibility = new IntersectionObserver(
			([entry]) => {
				visible = entry?.isIntersecting ?? false;
				if (reducedMotion || !drawing) return;
				if (visible && frame === 0) frame = requestAnimationFrame(loop);
				else if (!visible && frame !== 0) {
					cancelAnimationFrame(frame);
					frame = 0;
				}
			},
			{ rootMargin: "64px" },
		);
		visibility.observe(host);

		const resize = new ResizeObserver(() => {
			if (!measure()) return;
			start();
			draw(reducedMotion ? 0 : performance.now());
		});
		resize.observe(host);
		if (slot) resize.observe(slot);

		// A new theme brings new inks.
		const onTheme = () => {
			palette = readPalette();
			if (reducedMotion) draw(0);
		};
		window.addEventListener(THEME_EVENT, onTheme);

		if (finePointer) window.addEventListener("pointermove", onPointerMove, { passive: true });
		window.addEventListener("pointerdown", onPointerDown, { passive: true });
		window.addEventListener("pointerup", onPointerUp, { passive: true });
		window.addEventListener("pointercancel", onPointerCancel, { passive: true });
		window.addEventListener("contextmenu", onPointerCancel, { passive: true });

		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			visibility.disconnect();
			window.removeEventListener(THEME_EVENT, onTheme);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			window.removeEventListener("contextmenu", onPointerCancel);
		};
	}, [variant]);

	return <canvas ref={canvasRef} aria-hidden="true" className="field-in absolute inset-0 h-full w-full select-none" />;
}
