/**
 * Chrome offline T-Rex runner for the empty-session grid.
 *
 * When idle, the dino runs on autopilot along the top grid band — jumping over
 * saguaro clusters and ducking under low-flying pterodactyls. Taking control
 * hands jump (Space / Up / W) and duck (Down / S) over to the player.
 */

export const ARCADE_MODES = ["low", "mid", "hard"] as const;
export type ArcadeMode = (typeof ARCADE_MODES)[number];

/** One pixel of a sprite in grid-cell units (`PITCH = 7px`, so `0.36 * 7 ≈ 2.5px`). */
export const SPRITE_UNIT = 0.36;

export type SpeechBubble = {
	text: string;
	/** Grid cell the tail points at. */
	x: number;
	y: number;
	alpha: number;
};

export type DinoSpriteKind =
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
	| "star-edge";

export type DinoSprite = {
	kind: DinoSpriteKind;
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

const SPRITE_ROWS: Record<DinoSpriteKind, readonly string[]> = {
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

export const SPRITE_PATHS: Record<DinoSpriteKind, string> = {
	"dino-jump": traceRows(SPRITE_ROWS["dino-jump"]),
	"dino-run-a": traceRows(SPRITE_ROWS["dino-run-a"]),
	"dino-run-b": traceRows(SPRITE_ROWS["dino-run-b"]),
	"dino-duck-a": traceRows(SPRITE_ROWS["dino-duck-a"]),
	"dino-duck-b": traceRows(SPRITE_ROWS["dino-duck-b"]),
	"dino-crash": traceRows(SPRITE_ROWS["dino-crash"]),
	"cactus-small": traceRows(SPRITE_ROWS["cactus-small"]),
	"cactus-tall": traceRows(SPRITE_ROWS["cactus-tall"]),
	"ptero-up": traceRows(SPRITE_ROWS["ptero-up"]),
	"ptero-down": traceRows(SPRITE_ROWS["ptero-down"]),
	"star-face": traceRows(SPRITE_ROWS["star-face"]),
	"star-edge": traceRows(SPRITE_ROWS["star-edge"]),
};

const BOOT_FADE_MS = 420;
const LEG_STEP_MS = 95;
const WING_FLAP_MS = 160;
const STAR_SPIN_MS = 220;
const OVER_AUTO_RESET_MS = 2600;
const OVER_RESTART_GUARD_MS = 320;
const JUMP_BUFFER_MS = 130;

const GRAVITY = 240;
const FAST_FALL_MULTIPLIER = 2.8;
const JUMP_VELOCITY = 59;

const IDLE_SPEED = 34;
const SPEEDS: Record<ArcadeMode, { base: number; max: number; accel: number }> = {
	low: { base: 28, max: 44, accel: 0.45 },
	mid: { base: 36, max: 58, accel: 0.7 },
	hard: { base: 46, max: 72, accel: 1.0 },
};

const SPEECH_FADE_MS = 260;
const SPEECH_HOLD_MS = 2100;

const RUN_CHATTER = [
	"NO INTERNET?",
	"STILL RUNNING",
	"200 OK",
	"PING 0MS",
	"SHIP IT",
	"CACHE HIT",
	"ZERO DOWNTIME",
	"AIR TIME",
	"CLEARED IT",
	"HOLD MY COFFEE",
	"CHROME WHO?",
	"OFFLINE MODE",
	"FAST TRACK",
];

const CRASH_CHATTER = ["ERR_DISCONNECTED", "GAME OVER", "404: JUMP NOT FOUND", "MERGE CONFLICT", "SKILL ISSUE", "OOF"];

type CactusPiece = {
	kind: "cactus-small" | "cactus-tall";
	offsetX: number;
	widthPx: number;
	heightPx: number;
};

type Obstacle =
	| {
			type: "cactus";
			x: number;
			width: number;
			height: number;
			pieces: readonly CactusPiece[];
	  }
	| {
			type: "ptero";
			x: number;
			width: number;
			height: number;
			/** Cells above the ground baseline. */
			elevation: number;
	  };

type Cloud = {
	x: number;
	/** Cells above the ground baseline. */
	elevation: number;
	width: number;
	speedFactor: number;
};

type Dust = {
	x: number;
	/** Cells above the ground baseline. */
	elevation: number;
	age: number;
	life: number;
};

type StarPickup = {
	x: number;
	elevation: number;
	age: number;
};

type Speech = {
	text: string;
	age: number;
};

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function pick<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)]!;
}

/** Deterministic hash for scrolling ground pebbles so they stay fixed to world X. */
function groundHash(worldCol: number): number {
	const n = Math.imul(worldCol ^ 0x9e3779b9, 0x85ebca6b);
	return ((n ^ (n >>> 13)) >>> 0) / 0xffffffff;
}

export type DinoArcade = {
	resize(nextCols: number, nextRows: number): void;
	takeControl(): void;
	releaseControl(): void;
	jump(): void;
	setDuck(active: boolean): void;
	setMode(next: ArcadeMode): void;
	mode(): ArcadeMode;
	controlled(): boolean;
	score(): number;
	highScore(): number;
	gameOver(): boolean;
	step(dt: number): void;
	speechBubble(): SpeechBubble | null;
	sprites(): DinoSprite[];
	fade(): number;
	stamp(out: Float32Array, stampCols: number, stampRows: number): void;
};

export function createDinoArcade(): DinoArcade {
	let cols = 0;
	let rows = 0;
	let groundRow = 0;

	let booted = 0;
	let player = false;
	let mode: ArcadeMode = "mid";
	let status: "run" | "over" = "run";
	let overTimer = 0;

	let distance = 0;
	let bonusScore = 0;
	let score = 0;
	let highScore = 0;
	let nextMilestone = 100;

	let dinoY = 0;
	let dinoVy = 0;
	let ducking = false;
	let jumpBuffer = 0;
	let runClock = 0;
	let dustTimer = 0;

	let obstacles: Obstacle[] = [];
	let spawnGap = 28;
	let clouds: Cloud[] = [];
	let dust: Dust[] = [];
	let star: StarPickup | null = null;
	let starTimer = 4800;

	let speech: Speech | null = null;
	let lastSay = "";

	const computeGroundRow = () =>
		player
			? clamp(Math.floor(rows * 0.64), 14, Math.max(14, rows - 6))
			: clamp(Math.floor(rows * 0.68), 11, Math.max(11, rows - 3));

	const dinoX = () => clamp(Math.floor(cols * 0.14), 6, 22);

	const currentSpeed = () => {
		if (!player) return IDLE_SPEED;
		const spec = SPEEDS[mode];
		return Math.min(spec.max, spec.base + (distance / 40) * spec.accel);
	};

	const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

	const say = (pool: readonly string[]) => {
		let next = lastSay;
		while (next === lastSay && pool.length > 1) next = pick(pool);
		lastSay = next;
		speech = { text: next, age: 0 };
	};

	const spawnDust = (count: number) => {
		const baseX = dinoX() + 1.2;
		for (let i = 0; i < count; i++) {
			dust.push({
				x: baseX - Math.random() * 1.6,
				elevation: Math.random() * 1.2,
				age: 0,
				life: 180 + Math.random() * 120,
			});
		}
	};

	const seedClouds = () => {
		clouds = [];
		if (cols <= 0) return;
		const count = clamp(Math.floor(cols / 36), 2, 5);
		const skySpan = Math.max(5, groundRow - 8);
		for (let i = 0; i < count; i++) {
			clouds.push({
				x: Math.floor(((i + 0.35) / count) * cols),
				elevation: 6 + ((i * 5) % skySpan),
				width: 4 + (i % 3),
				speedFactor: 0.18 + (i % 3) * 0.05,
			});
		}
	};

	const makeCactusObstacle = (atX: number): Obstacle => {
		const roll = Math.random();
		const count = roll < 0.42 ? 1 : roll < 0.8 ? 2 : 3;
		const pieces: CactusPiece[] = [];
		let cursor = 0;
		let maxHeightPx = 0;

		for (let i = 0; i < count; i++) {
			const tall = Math.random() < 0.52;
			const kind = tall ? "cactus-tall" : "cactus-small";
			const widthPx = tall ? 10 : 8;
			const heightPx = tall ? 16 : 12;
			pieces.push({ kind, offsetX: cursor, widthPx, heightPx });
			cursor += (widthPx - 1) * SPRITE_UNIT;
			if (heightPx > maxHeightPx) maxHeightPx = heightPx;
		}

		const totalWidth = cursor + SPRITE_UNIT;
		return {
			type: "cactus",
			x: atX,
			width: totalWidth,
			height: maxHeightPx * SPRITE_UNIT,
			pieces,
		};
	};

	const makePteroObstacle = (atX: number): Obstacle => {
		// Low: jump over. Mid: duck under or jump over. High: duck under.
		const elevations = [0.8, 3.9, 4.6] as const;
		const elevation = pick(elevations);
		return {
			type: "ptero",
			x: atX,
			width: 16 * SPRITE_UNIT,
			height: 10 * SPRITE_UNIT,
			elevation,
		};
	};

	const spawnObstacle = () => {
		const spawnX = cols + 4;
		const canSpawnPtero = !player || score >= 90;
		const obstacle = canSpawnPtero && Math.random() < 0.28 ? makePteroObstacle(spawnX) : makeCactusObstacle(spawnX);
		obstacles.push(obstacle);

		const speed = currentSpeed();
		const minGap = speed * 0.68;
		const maxGap = speed * 1.25;
		spawnGap = minGap + Math.random() * (maxGap - minGap);
	};

	const maybeSpawnStar = () => {
		if (star || cols < 28) return;
		const spawnX = cols + 3;
		// Keep the pickup away from obstacles so jumping for it isn't a trap.
		const tooClose = obstacles.some((obs) => Math.abs(obs.x - spawnX) < 16);
		if (tooClose) return;
		star = {
			x: spawnX,
			elevation: 6.2 + Math.random() * 2.2,
			age: 0,
		};
	};

	const startRun = () => {
		status = "run";
		overTimer = 0;
		distance = 0;
		bonusScore = 0;
		score = 0;
		nextMilestone = 100;
		dinoY = 0;
		dinoVy = 0;
		ducking = false;
		jumpBuffer = 0;
		dust = [];
		star = null;
		starTimer = 3500 + Math.random() * 3500;
		speech = null;
		obstacles = [];
		if (cols > 0) {
			obstacles.push(makeCactusObstacle(Math.max(dinoX() + 34, Math.floor(cols * 0.72))));
		}
		spawnGap = 26 + Math.random() * 14;
	};

	const boot = () => {
		booted = 0;
		seedClouds();
		startRun();
	};

	const triggerJump = () => {
		if (dinoY <= 0.01) {
			dinoY = 0;
			dinoVy = JUMP_VELOCITY;
			jumpBuffer = 0;
			spawnDust(3);
			return true;
		}
		return false;
	};

	/** Autopilot: jumps over cacti & low pterodactyls, ducks under mid/high pterodactyls, and leaps for safe stars. */
	const thinkDino = () => {
		const x = dinoX();
		const standW = 16 * SPRITE_UNIT;
		const speed = currentSpeed();
		const next = obstacles.find((obs) => obs.x + obs.width > x + 0.6);

		if (next) {
			const dist = next.x - (x + standW);
			if (next.type === "ptero" && next.elevation >= 3.5) {
				ducking = dist < speed * 0.34 && next.x + next.width > x;
				return;
			}

			ducking = false;
			const jumpLead = speed * 0.18 + next.width * 0.18;
			if (dist <= jumpLead && dist > -1.5 && dinoY <= 0.01) {
				triggerJump();
				return;
			}
		} else {
			ducking = false;
		}

		// Leap for a floating star when no obstacle is near the landing spot.
		if (star && dinoY <= 0.01) {
			const starDist = star.x - (x + standW * 0.6);
			const safeLanding = !next || next.x - x > speed * 0.72;
			if (safeLanding && starDist <= speed * 0.16 && starDist > -1) {
				triggerJump();
			}
		}
	};

	const checkCollisions = () => {
		const x = dinoX();
		const isDucking = ducking && dinoY <= 0.05;
		const dinoW = (isDucking ? 20 : 16) * SPRITE_UNIT;
		const dinoH = (isDucking ? 10 : 16) * SPRITE_UNIT;

		const dLeft = x + 0.85;
		const dRight = x + dinoW - 0.75;
		const dBottom = dinoY + 0.25;
		const dTop = dinoY + dinoH - 0.35;

		if (star) {
			const sSize = 8 * SPRITE_UNIT;
			const sLeft = star.x;
			const sRight = star.x + sSize;
			const sBottom = star.elevation;
			const sTop = star.elevation + sSize;
			if (dRight >= sLeft && dLeft <= sRight && dTop >= sBottom && dBottom <= sTop) {
				star = null;
				starTimer = 5000 + Math.random() * 5000;
				bonusScore += 25;
				say(RUN_CHATTER);
			}
		}

		for (const obs of obstacles) {
			const oLeft = obs.x + 0.45;
			const oRight = obs.x + obs.width - 0.45;
			if (dRight < oLeft || dLeft > oRight) continue;

			const oBottom = obs.type === "ptero" ? obs.elevation + 0.35 : 0;
			const oTop = (obs.type === "ptero" ? obs.elevation : 0) + obs.height - 0.35;

			if (dTop >= oBottom && dBottom <= oTop) {
				if (player) {
					status = "over";
					overTimer = OVER_AUTO_RESET_MS;
					if (score > highScore) highScore = score;
					say(CRASH_CHATTER);
				} else {
					// Autopilot safety net if a resize dropped an obstacle on the dino.
					dinoVy = JUMP_VELOCITY;
				}
				return;
			}
		}
	};

	return {
		resize(nextCols: number, nextRows: number) {
			if (nextCols === cols && nextRows === rows) return;
			const hadBoard = cols > 0 && rows > 0;
			cols = nextCols;
			rows = nextRows;
			groundRow = computeGroundRow();
			if (!hadBoard) {
				boot();
				return;
			}
			seedClouds();
		},

		takeControl() {
			if (player) return;
			player = true;
			groundRow = computeGroundRow();
			booted = BOOT_FADE_MS;
			startRun();
		},

		releaseControl() {
			if (!player) return;
			player = false;
			groundRow = computeGroundRow();
			startRun();
		},

		jump() {
			if (!player) return;
			if (status === "over") {
				if (overTimer <= OVER_AUTO_RESET_MS - OVER_RESTART_GUARD_MS) {
					startRun();
				}
				return;
			}
			ducking = false;
			if (!triggerJump()) {
				jumpBuffer = JUMP_BUFFER_MS;
			}
		},

		setDuck(active: boolean) {
			if (!player) return;
			ducking = active;
		},

		setMode(next: ArcadeMode) {
			mode = next;
		},

		mode() {
			return mode;
		},

		controlled() {
			return player;
		},

		score() {
			return score;
		},

		highScore() {
			return highScore;
		},

		gameOver() {
			return status === "over";
		},

		step(dt: number) {
			if (cols <= 0 || rows <= 0) return;
			booted += dt;
			runClock += dt;

			if (speech) {
				speech.age += dt;
				if (speech.age >= SPEECH_HOLD_MS + SPEECH_FADE_MS) speech = null;
			}

			for (const puff of dust) puff.age += dt;
			dust = dust.filter((puff) => puff.age < puff.life);

			if (status === "over") {
				overTimer -= dt;
				if (overTimer <= 0) startRun();
				return;
			}

			if (!player) {
				thinkDino();
			} else if (jumpBuffer > 0) {
				jumpBuffer = Math.max(0, jumpBuffer - dt);
				if (dinoY <= 0.01) triggerJump();
			}

			const dtSec = Math.min(0.05, dt / 1000);
			const speed = currentSpeed();
			const dx = speed * dtSec;
			distance += dx;

			score = Math.floor(distance * 0.35) + bonusScore;
			if (score > highScore && player) highScore = score;
			if (score >= nextMilestone) {
				nextMilestone += 100;
				if (!speech) say(RUN_CHATTER);
			}

			// Vertical jump physics + fast-fall when holding duck in mid-air.
			if (dinoY > 0 || dinoVy > 0) {
				const gravity = ducking ? GRAVITY * FAST_FALL_MULTIPLIER : GRAVITY;
				if (ducking && dinoVy > 0) dinoVy *= 0.6;
				dinoY += dinoVy * dtSec;
				dinoVy -= gravity * dtSec;
				if (dinoY <= 0) {
					dinoY = 0;
					dinoVy = 0;
					spawnDust(2);
					if (jumpBuffer > 0) triggerJump();
				}
			} else {
				dustTimer += dt;
				if (dustTimer >= 150) {
					dustTimer = 0;
					spawnDust(1);
				}
			}

			for (const puff of dust) {
				puff.x -= dx * 0.55;
				puff.elevation += dtSec * 1.4;
			}

			const skySpan = Math.max(5, groundRow - 8);
			for (const cloud of clouds) {
				cloud.x -= dx * cloud.speedFactor;
				if (cloud.x + cloud.width < -2) {
					cloud.x = cols + 2 + Math.random() * 12;
					cloud.elevation = 6 + Math.floor(Math.random() * skySpan);
				}
			}

			for (const obs of obstacles) {
				obs.x -= dx;
			}
			obstacles = obstacles.filter((obs) => obs.x + obs.width > -4);

			const lastObs = obstacles[obstacles.length - 1];
			const tailDist = lastObs ? cols - (lastObs.x + lastObs.width) : Infinity;
			if (tailDist >= spawnGap) {
				spawnObstacle();
			}

			if (star) {
				star.age += dt;
				star.x -= dx;
				if (star.x < -4) {
					star = null;
					starTimer = 4500 + Math.random() * 4500;
				}
			} else {
				starTimer -= dt;
				if (starTimer <= 0) {
					maybeSpawnStar();
					if (!star) starTimer = 1800;
				}
			}

			checkCollisions();
		},

		speechBubble(): SpeechBubble | null {
			if (!speech) return null;
			const fadeIn = Math.min(1, speech.age / SPEECH_FADE_MS);
			const fadeOut = Math.max(0, 1 - (speech.age - SPEECH_HOLD_MS) / SPEECH_FADE_MS);
			const alpha = Math.min(fadeIn, fadeOut) * bootAlpha();
			const isDucking = ducking && dinoY <= 0.05 && status === "run";
			const dinoH = (isDucking ? 10 : 16) * SPRITE_UNIT;
			const headX = dinoX() + (isDucking ? 16 : 12) * SPRITE_UNIT;
			const headY = groundRow - dinoY * 0.25 - dinoH;
			return {
				text: speech.text,
				x: headX,
				y: headY,
				alpha,
			};
		},

		sprites(): DinoSprite[] {
			if (cols <= 0 || rows <= 0) return [];
			const alpha = bootAlpha();
			const dim = status === "over" ? 0.75 : 1;
			const out: DinoSprite[] = [];

			if (star) {
				const edge = Math.floor(star.age / STAR_SPIN_MS) % 2 === 1;
				const bob = Math.sin(star.age / 180) * 0.35;
				out.push({
					kind: edge ? "star-edge" : "star-face",
					x: star.x,
					y: groundRow - (star.elevation + bob) - 8 * SPRITE_UNIT,
					width: 8,
					height: 8,
					alpha: alpha * 0.9 * dim,
				});
			}

			const flap = Math.floor(runClock / WING_FLAP_MS) % 2 === 0;
			for (const obs of obstacles) {
				if (obs.type === "cactus") {
					for (const piece of obs.pieces) {
						out.push({
							kind: piece.kind,
							x: obs.x + piece.offsetX,
							y: groundRow - piece.heightPx * SPRITE_UNIT,
							width: piece.widthPx,
							height: piece.heightPx,
							alpha: alpha * 0.85 * dim,
						});
					}
				} else {
					out.push({
						kind: flap ? "ptero-up" : "ptero-down",
						x: obs.x,
						y: groundRow - obs.elevation - 12 * SPRITE_UNIT,
						width: 16,
						height: 12,
						alpha: alpha * 0.88 * dim,
					});
				}
			}

			const stepA = Math.floor(runClock / LEG_STEP_MS) % 2 === 0;
			const isDucking = ducking && dinoY <= 0.05 && status === "run";
			const dinoKind: DinoSpriteKind =
				status === "over"
					? "dino-crash"
					: dinoY > 0.05
						? "dino-jump"
						: isDucking
							? stepA
								? "dino-duck-a"
								: "dino-duck-b"
							: stepA
								? "dino-run-a"
								: "dino-run-b";
			const dinoW = isDucking ? 20 : 16;
			const dinoH = isDucking ? 10 : 16;

			out.push({
				kind: dinoKind,
				x: dinoX(),
				y: groundRow - dinoY - dinoH * SPRITE_UNIT,
				width: dinoW,
				height: dinoH,
				alpha,
			});

			return out;
		},

		fade() {
			return bootAlpha();
		},

		stamp(out: Float32Array, stampCols: number, stampRows: number) {
			if (cols <= 0 || rows <= 0) return;
			const alpha = bootAlpha();
			const dim = status === "over" ? 0.5 : 1;

			const light = (x: number, y: number, value: number) => {
				if (x < 0 || y < 0 || x >= stampCols || y >= stampRows) return;
				const index = y * stampCols + x;
				if ((out[index] ?? 0) < value) out[index] = value;
			};

			// Clouds drifting through the upper sky.
			for (const cloud of clouds) {
				const cx = Math.round(cloud.x);
				const cy = groundRow - Math.round(cloud.elevation);
				for (let dx = 0; dx < cloud.width; dx++) {
					light(cx + dx, cy, 0.22 * dim);
					if (dx > 0 && dx < cloud.width - 1) {
						light(cx + dx, cy - 1, 0.16 * dim);
					}
				}
			}

			// Scrolling horizon line and desert pebbles underneath.
			const worldOffset = Math.floor(distance);
			for (let x = 0; x < stampCols; x++) {
				const wx = x + worldOffset;
				const h = groundHash(wx);
				// Occasional 1-cell desert ridge or dip along the horizon.
				const ridge = h > 0.96 ? -1 : 0;
				light(x, groundRow + ridge, 0.42 * dim);

				if (h < 0.22) {
					light(x, groundRow + 1, 0.24 * dim);
				} else if (h > 0.76 && h < 0.86) {
					light(x, groundRow + 2, 0.15 * dim);
				}
			}

			// Footstep & landing dust puffs.
			for (const puff of dust) {
				const life = 1 - puff.age / puff.life;
				if (life <= 0) continue;
				light(Math.round(puff.x), groundRow - 1 - Math.round(puff.elevation), 0.55 * life * dim);
			}

			if (alpha >= 0.999) return;
			for (let i = 0; i < out.length; i++) out[i]! *= alpha;
		},
	};
}
