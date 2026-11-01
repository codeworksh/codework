/**
 * Space Invaders / Galaga arcade for the empty-session grid.
 *
 * When idle, the starfighter strafes along the bottom of the top grid band,
 * dodging incoming plasma bolts and blasting marching alien ranks, Galaga
 * dive-bombers, and mystery UFOs. Taking control hands movement (Left/Right or
 * A/D) and laser fire (Space/Up/W or tap) over to the player.
 */

import type { ArcadeMode, ArcadeSprite, ArcadeSpriteKind, GridArcade, SpeechBubble } from "./games";

const SPRITE_UNIT = 0.36;
const BOOT_FADE_MS = 420;
const START_LIVES = 3;
const HIT_STUN_MS = 900;
const CLEAR_PAUSE_MS = 1100;
const OVER_AUTO_RESET_MS = 2600;
const OVER_RESTART_GUARD_MS = 320;

const SHIP_WIDTH_PX = 13;
const SHIP_HEIGHT_PX = 8;
const SHIP_WIDTH = SHIP_WIDTH_PX * SPRITE_UNIT;
const SHIP_HEIGHT = SHIP_HEIGHT_PX * SPRITE_UNIT;
const SHIP_SPEED = 42;

const PLAYER_LASER_SPEED = 56;
const ENEMY_BOLT_SPEED: Record<ArcadeMode, number> = {
	low: 20,
	mid: 26,
	hard: 34,
};

const FIRE_COOLDOWN_MS: Record<ArcadeMode, number> = {
	low: 210,
	mid: 240,
	hard: 260,
};

const ENEMY_FIRE_MS: Record<ArcadeMode, { min: number; max: number }> = {
	low: { min: 950, max: 1650 },
	mid: { min: 620, max: 1150 },
	hard: { min: 380, max: 780 },
};

const DIVE_GAP_MS: Record<ArcadeMode, { min: number; max: number }> = {
	low: { min: 5200, max: 8400 },
	mid: { min: 3400, max: 6200 },
	hard: { min: 2200, max: 4200 },
};

const MARCH_SPEED: Record<ArcadeMode, number> = {
	low: 4.2,
	mid: 5.8,
	hard: 7.8,
};

const SPEECH_FADE_MS = 260;
const SPEECH_HOLD_MS = 2100;

const HIT_CHATTER = [
	"TARGET LOCKED",
	"DIRECT HIT",
	"PEW PEW",
	"200 OK",
	"BUG SQUASHED",
	"ZERO LATENCY",
	"SHIP IT",
	"CLEAN SWEEP",
	"CRITICAL HIT",
];

const UFO_CHATTER = ["MOTHERSHIP DOWN", "JACKPOT!", "+100 BONUS", "BULLSEYE", "ORBIT CLEARED"];

const DAMAGE_CHATTER = ["SHIELDS DOWN", "HULL BREACH", "TAKING FIRE", "WATCH YOUR SIX"];

const OVER_CHATTER = ["GAME OVER", "SECTOR LOST", "MISSION FAILED", "SKILL ISSUE", "INSERT COIN"];

type AlienRank = "squid" | "crab" | "octo";

type Alien = {
	rank: AlienRank;
	col: number;
	row: number;
	alive: boolean;
	widthPx: number;
	heightPx: number;
	points: number;
	/** Galaga dive state when peeling out of formation. */
	diving: {
		x: number;
		y: number;
		vx: number;
		vy: number;
		phase: number;
		fired: boolean;
	} | null;
};

type Shot = {
	x: number;
	y: number;
	fromPlayer: boolean;
};

type Spark = {
	x: number;
	y: number;
	vx: number;
	vy: number;
	age: number;
	life: number;
};

type Ufo = {
	x: number;
	y: number;
	dir: 1 | -1;
};

type Star = {
	x: number;
	y: number;
	speed: number;
	bright: number;
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

const LEFT_KEYS = new Set(["ArrowLeft", "a", "A"]);
const RIGHT_KEYS = new Set(["ArrowRight", "d", "D"]);
const FIRE_KEYS = new Set([" ", "Spacebar", "ArrowUp", "w", "W"]);

export function createInvadersArcade(): GridArcade {
	let cols = 0;
	let rows = 0;
	let shipRow = 0;

	let booted = 0;
	let player = false;
	let mode: ArcadeMode = "mid";
	let status: "run" | "hit" | "clear" | "over" = "run";
	let statusTimer = 0;

	let score = 0;
	let highScore = 0;
	let lives = START_LIVES;
	let wave = 1;

	let shipX = 0;
	let holdLeft = false;
	let holdRight = false;
	let holdFire = false;
	let pointerTargetX: number | null = null;
	let fireCooldown = 0;

	let fleetX = 0;
	let fleetY = 0;
	let fleetDir: 1 | -1 = 1;
	let cellStepX = 6;
	let cellStepY = 4;
	let animClock = 0;

	let aliens: Alien[] = [];
	let shots: Shot[] = [];
	let sparks: Spark[] = [];
	let stars: Star[] = [];
	let bunkers = new Set<string>();

	let ufo: Ufo | null = null;
	let ufoTimer = 9000;
	let enemyFireTimer = 900;
	let diveTimer = 4200;

	let speech: Speech | null = null;
	let lastSay = "";

	const cellKey = (x: number, y: number) => `${x},${y}`;

	const computeShipRow = () =>
		player
			? clamp(Math.floor(rows * 0.82), 18, Math.max(18, rows - 5))
			: clamp(Math.floor(rows * 0.68), 13, Math.max(13, rows - 3));

	const bootAlpha = () => Math.min(1, booted / BOOT_FADE_MS);

	const say = (pool: readonly string[]) => {
		let next = lastSay;
		while (next === lastSay && pool.length > 1) next = pick(pool);
		lastSay = next;
		speech = { text: next, age: 0 };
	};

	const seedStars = () => {
		stars = [];
		if (cols <= 0 || rows <= 0) return;
		const count = clamp(Math.floor((cols * rows) / 95), 14, 48);
		for (let i = 0; i < count; i++) {
			stars.push({
				x: Math.random() * cols,
				y: Math.random() * rows,
				speed: 1.5 + (i % 3) * 1.1,
				bright: 0.12 + (i % 4) * 0.05,
			});
		}
	};

	const buildBunkers = () => {
		bunkers.clear();
		if (!player || cols < 36 || shipRow < 20) return;

		const count = 4;
		const bunkerY = shipRow - 5;
		const pattern = ["0111110", "1111111", "1100011"];

		for (let i = 0; i < count; i++) {
			const centerX = Math.floor(((i + 0.5) / count) * (cols - 16)) + 8;
			const startX = centerX - 3;
			for (let dy = 0; dy < pattern.length; dy++) {
				const rowBits = pattern[dy]!;
				for (let dx = 0; dx < rowBits.length; dx++) {
					if (rowBits[dx] === "1") {
						bunkers.add(cellKey(startX + dx, bunkerY + dy));
					}
				}
			}
		}
	};

	const fleetSpacing = (fleetCols: number) =>
		Math.min(
			clamp((cols - 16) / Math.max(8, fleetCols + 2), 5.4, 7.2),
			Math.max(0, (cols - 12 - 12 * SPRITE_UNIT) / Math.max(1, fleetCols - 1)),
		);

	const buildFleet = () => {
		aliens = [];
		shots = [];
		ufo = null;

		const fleetCols = clamp(Math.floor((cols - 16) / 7), 5, player ? 10 : 8);
		const fleetRows = player ? (rows >= 42 ? 4 : 3) : 2;
		cellStepX = fleetSpacing(fleetCols);
		cellStepY = player ? 4.2 : 3.6;

		const totalWidth = (fleetCols - 1) * cellStepX + 12 * SPRITE_UNIT;
		fleetX = Math.max(4, (cols - totalWidth) / 2);
		fleetY = player ? 7.8 : 1.6;
		fleetDir = 1;

		for (let r = 0; r < fleetRows; r++) {
			const rank: AlienRank = r === 0 ? "squid" : r < fleetRows - 1 ? "crab" : "octo";
			const widthPx = rank === "squid" ? 8 : rank === "crab" ? 11 : 12;
			const points = rank === "squid" ? 30 : rank === "crab" ? 20 : 10;
			for (let c = 0; c < fleetCols; c++) {
				aliens.push({
					rank,
					col: c,
					row: r,
					alive: true,
					widthPx,
					heightPx: 8,
					points,
					diving: null,
				});
			}
		}

		const fireSpec = ENEMY_FIRE_MS[mode];
		enemyFireTimer = fireSpec.min + Math.random() * (fireSpec.max - fireSpec.min);
		const diveSpec = DIVE_GAP_MS[mode];
		diveTimer = diveSpec.min + Math.random() * (diveSpec.max - diveSpec.min);
	};

	const alienSlot = (alien: Alien) => {
		const w = alien.widthPx * SPRITE_UNIT;
		return {
			x: fleetX + alien.col * cellStepX + (12 * SPRITE_UNIT - w) / 2,
			y: fleetY + alien.row * cellStepY,
			w,
			h: alien.heightPx * SPRITE_UNIT,
		};
	};

	const alienRect = (alien: Alien) => {
		const w = alien.widthPx * SPRITE_UNIT;
		const h = alien.heightPx * SPRITE_UNIT;
		if (alien.diving) {
			return { x: alien.diving.x, y: alien.diving.y, w, h };
		}
		return alienSlot(alien);
	};

	const spawnExplosion = (cx: number, cy: number, count: number) => {
		for (let i = 0; i < count; i++) {
			const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
			const speed = 6 + Math.random() * 14;
			sparks.push({
				x: cx,
				y: cy,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				age: 0,
				life: 200 + Math.random() * 140,
			});
		}
	};

	const firePlayerShot = () => {
		if (fireCooldown > 0 || status !== "run") return;
		const activePlayerShots = shots.filter((s) => s.fromPlayer).length;
		if (activePlayerShots >= 3) return;

		fireCooldown = player ? FIRE_COOLDOWN_MS[mode] : 240;
		shots.push({
			x: shipX + SHIP_WIDTH / 2,
			y: shipRow - 0.6,
			fromPlayer: true,
		});
	};

	const startGame = () => {
		status = "run";
		statusTimer = 0;
		score = 0;
		lives = START_LIVES;
		wave = 1;
		holdLeft = false;
		holdRight = false;
		holdFire = false;
		pointerTargetX = null;
		fireCooldown = 0;
		sparks = [];
		speech = null;
		ufoTimer = 7000 + Math.random() * 6000;
		shipX = Math.max(3, (cols - SHIP_WIDTH) / 2);
		buildBunkers();
		buildFleet();
	};

	const boot = () => {
		booted = 0;
		seedStars();
		startGame();
	};

	/** Autopilot: dodges falling plasma bolts and lines up shots under UFOs, divers, and front-line aliens. */
	const thinkShip = (dtSec: number) => {
		const shipCenter = shipX + SHIP_WIDTH / 2;

		// 1. Check for imminent danger from enemy bolts or diving aliens.
		let threatX: number | null = null;
		let minThreatDist = Infinity;

		for (const shot of shots) {
			if (shot.fromPlayer) continue;
			const dy = shipRow - shot.y;
			const dx = Math.abs(shot.x - shipCenter);
			if (dy > -1 && dy < 11 && dx < SHIP_WIDTH * 0.95 && dy < minThreatDist) {
				minThreatDist = dy;
				threatX = shot.x;
			}
		}

		for (const alien of aliens) {
			if (!alien.alive || !alien.diving) continue;
			const dy = shipRow - alien.diving.y;
			const dx = Math.abs(alien.diving.x + (alien.widthPx * SPRITE_UNIT) / 2 - shipCenter);
			if (dy > -2 && dy < 10 && dx < SHIP_WIDTH * 1.1 && dy < minThreatDist) {
				minThreatDist = dy;
				threatX = alien.diving.x + (alien.widthPx * SPRITE_UNIT) / 2;
			}
		}

		if (threatX !== null) {
			const escapeDir = shipCenter < 10 ? 1 : shipCenter > cols - 10 ? -1 : shipCenter >= threatX ? 1 : -1;
			shipX = clamp(shipX + escapeDir * SHIP_SPEED * dtSec, 3, Math.max(3, cols - SHIP_WIDTH - 3));
			if (fireCooldown <= 0) firePlayerShot();
			return;
		}

		// 2. Pick an offensive target: UFO > diving alien > lowest alien nearest ship.
		let targetX: number | null = null;
		if (ufo) {
			targetX = ufo.x + (14 * SPRITE_UNIT) / 2;
		} else {
			let bestScore = -Infinity;
			for (const alien of aliens) {
				if (!alien.alive) continue;
				const rect = alienRect(alien);
				const cx = rect.x + rect.w / 2;
				const priority = (alien.diving ? 40 : 0) + rect.y * 2 - Math.abs(cx - shipCenter) * 0.35;
				if (priority > bestScore) {
					bestScore = priority;
					targetX = cx;
				}
			}
		}

		if (targetX !== null) {
			const diff = targetX - shipCenter;
			if (Math.abs(diff) > 0.6) {
				const step = Math.sign(diff) * Math.min(Math.abs(diff), SHIP_SPEED * 0.82 * dtSec);
				shipX = clamp(shipX + step, 3, Math.max(3, cols - SHIP_WIDTH - 3));
			}
			if (Math.abs(diff) < 3.2) {
				firePlayerShot();
			}
		}
	};

	const damagePlayer = () => {
		spawnExplosion(shipX + SHIP_WIDTH / 2, shipRow + SHIP_HEIGHT / 2, 10);
		if (!player) {
			// Autopilot shrugs off rare hits.
			return;
		}
		lives = Math.max(0, lives - 1);
		if (lives <= 0) {
			status = "over";
			statusTimer = OVER_AUTO_RESET_MS;
			if (score > highScore) highScore = score;
			say(OVER_CHATTER);
		} else {
			status = "hit";
			statusTimer = HIT_STUN_MS;
			shots = shots.filter((s) => s.fromPlayer);
			say(DAMAGE_CHATTER);
		}
	};

	return {
		resize(nextCols: number, nextRows: number) {
			if (nextCols === cols && nextRows === rows) return;
			const hadBoard = cols > 0 && rows > 0;
			const widthChanged = nextCols !== cols;
			const majorHeightChange = Math.abs(nextRows - rows) > 10;
			cols = nextCols;
			rows = nextRows;
			shipRow = computeShipRow();
			if (!hadBoard) {
				boot();
				return;
			}
			shipX = clamp(shipX, 3, Math.max(3, cols - SHIP_WIDTH - 3));
			seedStars();
			buildBunkers();
			if (majorHeightChange && score === 0) {
				shipX = Math.max(3, (cols - SHIP_WIDTH) / 2);
				buildFleet();
			} else if (widthChanged) {
				const fleetCols = Math.max(...aliens.map((alien) => alien.col)) + 1;
				cellStepX = fleetSpacing(fleetCols);
				const totalWidth = (fleetCols - 1) * cellStepX + 12 * SPRITE_UNIT;
				fleetX = clamp(fleetX, 3, Math.max(3, cols - 3 - totalWidth));
				for (const alien of aliens) {
					if (alien.diving) alien.diving.x = clamp(alien.diving.x, 2, cols - 6);
				}
			}
		},

		takeControl() {
			if (player) return;
			player = true;
			shipRow = computeShipRow();
			booted = BOOT_FADE_MS;
			startGame();
		},

		releaseControl() {
			if (!player) return;
			player = false;
			shipRow = computeShipRow();
			startGame();
		},

		keyDown(key: string, repeat: boolean) {
			if (!player) return false;
			if (status === "over") {
				if (!repeat && FIRE_KEYS.has(key) && statusTimer <= OVER_AUTO_RESET_MS - OVER_RESTART_GUARD_MS) {
					startGame();
				}
				return FIRE_KEYS.has(key) || LEFT_KEYS.has(key) || RIGHT_KEYS.has(key);
			}
			if (LEFT_KEYS.has(key)) {
				holdLeft = true;
				pointerTargetX = null;
				return true;
			}
			if (RIGHT_KEYS.has(key)) {
				holdRight = true;
				pointerTargetX = null;
				return true;
			}
			if (FIRE_KEYS.has(key)) {
				holdFire = true;
				firePlayerShot();
				return true;
			}
			return false;
		},

		keyUp(key: string) {
			if (LEFT_KEYS.has(key)) holdLeft = false;
			if (RIGHT_KEYS.has(key)) holdRight = false;
			if (FIRE_KEYS.has(key)) holdFire = false;
		},

		blur() {
			holdLeft = false;
			holdRight = false;
			holdFire = false;
			pointerTargetX = null;
		},

		pointerDown(xRatio: number) {
			if (!player) return;
			if (status === "over") {
				if (statusTimer <= OVER_AUTO_RESET_MS - OVER_RESTART_GUARD_MS) {
					startGame();
				}
				return;
			}
			pointerTargetX = clamp(xRatio * cols - SHIP_WIDTH / 2, 3, Math.max(3, cols - SHIP_WIDTH - 3));
			firePlayerShot();
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

		lives() {
			return lives;
		},

		gameOver() {
			return status === "over";
		},

		step(dt: number) {
			if (cols <= 0 || rows <= 0) return;
			booted += dt;
			animClock += dt;
			fireCooldown = Math.max(0, fireCooldown - dt);

			if (speech) {
				speech.age += dt;
				if (speech.age >= SPEECH_HOLD_MS + SPEECH_FADE_MS) speech = null;
			}

			const dtSec = Math.min(0.05, dt / 1000);

			for (const star of stars) {
				star.y += star.speed * dtSec;
				if (star.y >= rows) {
					star.y = 0;
					star.x = Math.random() * cols;
				}
			}

			for (const spark of sparks) {
				spark.age += dt;
				spark.x += spark.vx * dtSec;
				spark.y += spark.vy * dtSec;
			}
			sparks = sparks.filter((spark) => spark.age < spark.life);

			if (status !== "run") {
				statusTimer -= dt;
				if (statusTimer > 0) return;
				if (status === "over") {
					startGame();
				} else if (status === "clear") {
					wave += 1;
					buildBunkers();
					buildFleet();
					status = "run";
				} else {
					status = "run";
				}
				return;
			}

			// 1. Move player or autopilot starfighter.
			if (player) {
				const dir = (holdRight ? 1 : 0) - (holdLeft ? 1 : 0);
				if (dir !== 0) {
					shipX = clamp(shipX + dir * SHIP_SPEED * dtSec, 3, Math.max(3, cols - SHIP_WIDTH - 3));
				} else if (pointerTargetX !== null) {
					const diff = pointerTargetX - shipX;
					if (Math.abs(diff) <= 0.5) {
						shipX = pointerTargetX;
						pointerTargetX = null;
					} else {
						shipX = clamp(
							shipX + Math.sign(diff) * Math.min(Math.abs(diff), SHIP_SPEED * dtSec),
							3,
							Math.max(3, cols - SHIP_WIDTH - 3),
						);
					}
				}
				if (holdFire && fireCooldown <= 0) firePlayerShot();
			} else {
				thinkShip(dtSec);
			}

			// 2. Advance formation march; fewer remaining aliens march faster.
			const living = aliens.filter((a) => a.alive);
			if (living.length === 0) {
				status = "clear";
				statusTimer = CLEAR_PAUSE_MS;
				say(["WAVE CLEAR", `WAVE ${wave} CLEAR`, "SECTOR SECURED"]);
				return;
			}

			const ratio = 1 - living.length / Math.max(1, aliens.length);
			const baseMarch = player ? MARCH_SPEED[mode] : MARCH_SPEED.mid;
			const marchSpeed = (baseMarch + ratio * baseMarch * 1.45) * (1 + Math.min(0.6, (wave - 1) * 0.12));
			fleetX += fleetDir * marchSpeed * dtSec;

			let minX = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const alien of living) {
				if (alien.diving) continue;
				const slot = alienSlot(alien);
				if (slot.x < minX) minX = slot.x;
				if (slot.x + slot.w > maxX) maxX = slot.x + slot.w;
				if (slot.y + slot.h > maxY) maxY = slot.y + slot.h;
			}

			if ((fleetDir === 1 && maxX >= cols - 3) || (fleetDir === -1 && minX <= 3)) {
				fleetDir = (fleetDir === 1 ? -1 : 1) as 1 | -1;
				fleetY += player ? 1.4 : 0.85;
				// In idle mode, loop the formation height before it reaches the ship.
				if (!player && maxY >= shipRow - 4) {
					fleetY = 1.6;
				}
			}

			if (player && maxY >= shipRow - 1) {
				lives = 0;
				status = "over";
				statusTimer = OVER_AUTO_RESET_MS;
				if (score > highScore) highScore = score;
				say(OVER_CHATTER);
				return;
			}

			// 3. Galaga dive-bombers.
			diveTimer -= dt;
			if (diveTimer <= 0) {
				const diveSpec = DIVE_GAP_MS[mode];
				diveTimer = diveSpec.min + Math.random() * (diveSpec.max - diveSpec.min);
				const activeDivers = living.filter((a) => a.diving !== null).length;
				if (activeDivers < (player && mode === "hard" ? 2 : 1)) {
					const candidates = living.filter((a) => a.diving === null);
					if (candidates.length > 0) {
						const diver = pick(candidates);
						const slot = alienSlot(diver);
						const aim = (shipX - slot.x) * 0.65;
						diver.diving = {
							x: slot.x,
							y: slot.y,
							vx: clamp(aim, -14, 14),
							vy: player ? 14 + (mode === "hard" ? 5 : 0) : 12,
							phase: Math.random() * Math.PI * 2,
							fired: false,
						};
					}
				}
			}

			for (const alien of living) {
				const d = alien.diving;
				if (!d) continue;
				d.phase += dtSec * 5;
				d.x = clamp(d.x + (d.vx + Math.sin(d.phase) * 9) * dtSec, 2, cols - 6);
				d.y += d.vy * dtSec;

				if (!d.fired && d.y >= shipRow * 0.48) {
					d.fired = true;
					shots.push({
						x: d.x + (alien.widthPx * SPRITE_UNIT) / 2,
						y: d.y + alien.heightPx * SPRITE_UNIT,
						fromPlayer: false,
					});
				}

				if (d.y > rows + 2) {
					alien.diving = null;
				}
			}

			// 4. Enemy plasma bolts from the formation front line.
			enemyFireTimer -= dt;
			if (enemyFireTimer <= 0) {
				const fireSpec = ENEMY_FIRE_MS[mode];
				enemyFireTimer = fireSpec.min + Math.random() * (fireSpec.max - fireSpec.min);
				const shooter = pick(living);
				const rect = alienRect(shooter);
				shots.push({
					x: rect.x + rect.w / 2,
					y: rect.y + rect.h,
					fromPlayer: false,
				});
			}

			// 5. Mystery UFO across the top row.
			if (ufo) {
				ufo.x += ufo.dir * 18 * dtSec;
				if (ufo.x < -8 || ufo.x > cols + 8) {
					ufo = null;
					ufoTimer = 11000 + Math.random() * 8000;
				}
			} else {
				ufoTimer -= dt;
				if (ufoTimer <= 0 && cols >= 32) {
					const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
					ufo = {
						x: dir === 1 ? -6 : cols + 2,
						y: player ? 4.8 : 0.4,
						dir,
					};
				}
			}

			// 6. Step laser & plasma bolts and check collisions.
			const boltSpeed = player ? ENEMY_BOLT_SPEED[mode] : ENEMY_BOLT_SPEED.mid;
			const survivingShots: Shot[] = [];

			for (const shot of shots) {
				shot.y += (shot.fromPlayer ? -PLAYER_LASER_SPEED : boltSpeed) * dtSec;
				if (shot.y < -2 || shot.y > rows + 2) continue;

				const gx = Math.round(shot.x);
				const gy = Math.round(shot.y);
				if (bunkers.delete(cellKey(gx, gy)) || bunkers.delete(cellKey(gx, gy + (shot.fromPlayer ? -1 : 1)))) {
					spawnExplosion(shot.x, shot.y, 4);
					continue;
				}

				if (shot.fromPlayer) {
					if (ufo) {
						const ufoW = 14 * SPRITE_UNIT;
						const ufoH = 6 * SPRITE_UNIT;
						if (
							shot.x >= ufo.x - 0.4 &&
							shot.x <= ufo.x + ufoW + 0.4 &&
							shot.y >= ufo.y - 0.4 &&
							shot.y <= ufo.y + ufoH + 0.4
						) {
							spawnExplosion(ufo.x + ufoW / 2, ufo.y + ufoH / 2, 10);
							ufo = null;
							ufoTimer = 12000 + Math.random() * 8000;
							score += 100;
							if (player && score > highScore) highScore = score;
							say(UFO_CHATTER);
							continue;
						}
					}

					let hitAlien = false;
					for (const alien of living) {
						if (!alien.alive) continue;
						const rect = alienRect(alien);
						if (
							shot.x >= rect.x - 0.35 &&
							shot.x <= rect.x + rect.w + 0.35 &&
							shot.y >= rect.y - 0.35 &&
							shot.y <= rect.y + rect.h + 0.35
						) {
							alien.alive = false;
							alien.diving = null;
							hitAlien = true;
							score += alien.points;
							if (player && score > highScore) highScore = score;
							spawnExplosion(rect.x + rect.w / 2, rect.y + rect.h / 2, 7);
							if (!speech && Math.random() < 0.28) say(HIT_CHATTER);
							break;
						}
					}
					if (hitAlien) continue;
				} else {
					if (
						shot.x >= shipX + 0.4 &&
						shot.x <= shipX + SHIP_WIDTH - 0.4 &&
						shot.y >= shipRow + 0.2 &&
						shot.y <= shipRow + SHIP_HEIGHT - 0.2
					) {
						damagePlayer();
						if (player) return;
						continue;
					}
				}

				survivingShots.push(shot);
			}
			shots = survivingShots;

			// 7. Check diving alien body collisions with bunkers or starfighter.
			for (const alien of living) {
				if (!alien.diving) continue;
				const rect = alienRect(alien);
				const gx = Math.round(rect.x + rect.w / 2);
				const gy = Math.round(rect.y + rect.h / 2);
				if (bunkers.delete(cellKey(gx, gy))) {
					alien.alive = false;
					alien.diving = null;
					spawnExplosion(rect.x + rect.w / 2, rect.y + rect.h / 2, 6);
					continue;
				}
				if (
					rect.x + rect.w - 0.5 >= shipX + 0.5 &&
					rect.x + 0.5 <= shipX + SHIP_WIDTH - 0.5 &&
					rect.y + rect.h - 0.4 >= shipRow + 0.4 &&
					rect.y + 0.4 <= shipRow + SHIP_HEIGHT - 0.4
				) {
					alien.alive = false;
					alien.diving = null;
					damagePlayer();
					return;
				}
			}
		},

		speechBubble(): SpeechBubble | null {
			if (!speech) return null;
			const fadeIn = Math.min(1, speech.age / SPEECH_FADE_MS);
			const fadeOut = Math.max(0, 1 - (speech.age - SPEECH_HOLD_MS) / SPEECH_FADE_MS);
			return {
				text: speech.text,
				x: shipX + SHIP_WIDTH / 2,
				y: shipRow - 0.8,
				alpha: Math.min(fadeIn, fadeOut) * bootAlpha(),
			};
		},

		sprites(): ArcadeSprite[] {
			if (cols <= 0 || rows <= 0) return [];
			const alpha = bootAlpha();
			const dim = status === "over" ? 0.65 : 1;
			const out: ArcadeSprite[] = [];

			if (ufo) {
				out.push({
					kind: "invader-ufo",
					x: ufo.x,
					y: ufo.y,
					width: 14,
					height: 6,
					alpha: alpha * 0.92 * dim,
				});
			}

			const frameA = Math.floor(animClock / 320) % 2 === 0;
			for (const alien of aliens) {
				if (!alien.alive) continue;
				const rect = alienRect(alien);
				const kind: ArcadeSpriteKind =
					alien.rank === "squid"
						? frameA
							? "invader-squid-a"
							: "invader-squid-b"
						: alien.rank === "crab"
							? frameA
								? "invader-crab-a"
								: "invader-crab-b"
							: frameA
								? "invader-octo-a"
								: "invader-octo-b";
				out.push({
					kind,
					x: rect.x,
					y: rect.y,
					width: alien.widthPx,
					height: alien.heightPx,
					alpha: alpha * (alien.diving ? 0.98 : 0.86) * dim,
				});
			}

			const hitFlash = status === "hit" && Math.floor(statusTimer / 90) % 2 === 0;
			out.push({
				kind: status === "hit" || status === "over" ? "ship-hit" : "ship-intact",
				x: shipX,
				y: shipRow,
				width: SHIP_WIDTH_PX,
				height: SHIP_HEIGHT_PX,
				alpha: alpha * (hitFlash ? 0.45 : 1) * dim,
			});

			return out;
		},

		fade() {
			return bootAlpha();
		},

		stamp(out: Float32Array, stampCols: number, stampRows: number) {
			if (cols <= 0 || rows <= 0) return;
			const alpha = bootAlpha();
			const dim = status === "over" ? 0.45 : 1;

			const light = (x: number, y: number, value: number) => {
				if (x < 0 || y < 0 || x >= stampCols || y >= stampRows) return;
				const index = y * stampCols + x;
				if ((out[index] ?? 0) < value) out[index] = value;
			};

			// Drifting starfield.
			for (const star of stars) {
				light(Math.floor(star.x), Math.floor(star.y), star.bright * dim);
			}

			// Destructible pixel bunkers.
			for (const entry of bunkers) {
				const [xStr, yStr] = entry.split(",");
				light(Number(xStr), Number(yStr), 0.58 * dim);
			}

			// Player lasers & alien plasma bolts.
			for (const shot of shots) {
				const sx = Math.round(shot.x);
				const sy = Math.round(shot.y);
				if (shot.fromPlayer) {
					light(sx, sy, 0.98 * dim);
					light(sx, sy + 1, 0.52 * dim);
				} else {
					light(sx, sy, 0.85 * dim);
					light(sx, sy - 1, 0.42 * dim);
				}
			}

			// Explosion sparks.
			for (const spark of sparks) {
				const life = 1 - spark.age / spark.life;
				if (life <= 0) continue;
				light(Math.round(spark.x), Math.round(spark.y), 0.82 * life * dim);
			}

			if (alpha >= 0.999) return;
			for (let i = 0; i < out.length; i++) out[i]! *= alpha;
		},
	};
}
