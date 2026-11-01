import { useCallback, useEffect, useRef, useState } from "react";

import {
	ARCADE_MODES,
	type ArcadeMode,
	type ArcadeSprite,
	type ArcadeSpriteKind,
	GRID_GAMES,
	type GridArcade,
	type GridGame,
	SLIDE_HOLD_MS,
	SPRITE_PATHS,
	SPRITE_UNIT,
	stepSlider,
} from "./games";

const CELL = 6;
const GAP = 1;
const PITCH = CELL + GAP;
const BORDER_OPACITY = 0.06;
const PEAK_OPACITY = 0.72;
const SPRITE_OPACITY = 0.92;
const BUBBLE_OPACITY = 0.9;
const BUBBLE_EASE = 0.22;
const FRAME_MS = 33;
/** The slide transition, plus a frame of slack, while both boards show. */
const SLIDE_MS = 800;

/** One "pixel" of the speech bubble art, in CSS px. */
const UNIT = 2;
const STEP = UNIT;
const TAIL_STEPS = 3;
const TAIL_H = TAIL_STEPS * STEP;
const SHADOW_OFFSET = 2 * UNIT;
const FONT_PX = 10;
const PAD_X = 3 * UNIT;
const PAD_Y = 2 * UNIT;
const FONT = `600 ${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;

const snap = (value: number) => Math.round(value / UNIT) * UNIT;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Point = readonly [number, number];

type Board = {
	game: GridGame;
	arcade: GridArcade;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	bubbleAt: { x: number; y: number } | null;
};

function outline(x: number, y: number, w: number, h: number, tailX: number, below: boolean): Point[] {
	const points: Point[] = [];
	const at = (px: number, py: number) => points.push([px, py]);

	at(x + STEP, y);
	if (below) {
		at(x + tailX, y);
		at(x + tailX, y - TAIL_H);
		for (let step = TAIL_STEPS; step > 0; step--) {
			at(x + tailX + (TAIL_STEPS - step + 1) * STEP, y - step * STEP);
			at(x + tailX + (TAIL_STEPS - step + 1) * STEP, y - (step - 1) * STEP);
		}
	}
	at(x + w - STEP, y);
	at(x + w - STEP, y + STEP);
	at(x + w, y + STEP);

	at(x + w, y + h - STEP);
	at(x + w - STEP, y + h - STEP);
	at(x + w - STEP, y + h);
	if (!below) {
		for (let step = 1; step <= TAIL_STEPS; step++) {
			at(x + tailX + (TAIL_STEPS - step + 1) * STEP, y + h + (step - 1) * STEP);
			at(x + tailX + (TAIL_STEPS - step + 1) * STEP, y + h + step * STEP);
		}
		at(x + tailX, y + h + TAIL_H);
		at(x + tailX, y + h);
	}
	at(x + STEP, y + h);
	at(x + STEP, y + h - STEP);
	at(x, y + h - STEP);

	at(x, y + STEP);
	at(x + STEP, y + STEP);

	return points;
}

function trace(ctx: CanvasRenderingContext2D, points: readonly Point[]) {
	ctx.beginPath();
	points.forEach(([x, y], index) => {
		if (index === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	});
	ctx.closePath();
}

function drawSpeechBubble(
	ctx: CanvasRenderingContext2D,
	text: string,
	headX: number,
	headY: number,
	headSize: number,
	bounds: { width: number; height: number },
	alpha: number,
	theme: { fg: string; bg: string },
) {
	if (alpha <= 0.01) return;

	ctx.save();
	ctx.font = FONT;
	if ("letterSpacing" in ctx) ctx.letterSpacing = "1px";

	const w = snap(ctx.measureText(text).width + PAD_X * 2);
	const h = snap(FONT_PX + PAD_Y * 2);
	const margin = UNIT + SHADOW_OFFSET;

	const above = headY - UNIT - TAIL_H - h;
	const below = above < margin;
	const y = snap(below ? headY + headSize + UNIT + TAIL_H : above);

	const preferred = headX - 4 * STEP;
	const x = snap(clamp(preferred, margin, Math.max(margin, bounds.width - w - margin)));
	const tailX = clamp(snap(headX - x), 2 * STEP, Math.max(2 * STEP, w - (TAIL_STEPS + 2) * STEP));

	ctx.globalAlpha = alpha;
	ctx.lineJoin = "miter";
	ctx.lineWidth = UNIT;

	ctx.fillStyle = theme.fg;
	ctx.globalAlpha = alpha * 0.2;
	trace(ctx, outline(x + SHADOW_OFFSET, y + SHADOW_OFFSET, w, h, tailX, below));
	ctx.fill();

	ctx.globalAlpha = alpha;
	trace(ctx, outline(x, y, w, h, tailX, below));
	ctx.fillStyle = theme.bg;
	ctx.fill();
	ctx.strokeStyle = theme.fg;
	ctx.stroke();

	ctx.fillStyle = theme.fg;
	ctx.textBaseline = "middle";
	ctx.textAlign = "left";
	ctx.fillText(text, x + PAD_X, y + h / 2 + 1);

	ctx.restore();
}

const spritePaths = new Map<ArcadeSpriteKind, Path2D>();

function getSpritePath(kind: ArcadeSpriteKind): Path2D {
	const cached = spritePaths.get(kind);
	if (cached !== undefined) return cached;
	const path = new Path2D(SPRITE_PATHS[kind]);
	spritePaths.set(kind, path);
	return path;
}

function drawSprite(ctx: CanvasRenderingContext2D, sprite: ArcadeSprite, fill: string) {
	const path = getSpritePath(sprite.kind);
	const unit = SPRITE_UNIT * PITCH;
	const left = sprite.x * PITCH;
	const top = sprite.y * PITCH;

	ctx.save();
	ctx.fillStyle = fill;
	ctx.translate(left, top);
	ctx.scale(unit, unit);
	ctx.fill(path);
	ctx.restore();
}

function parseRgb(value: string, fallback: string) {
	const match = value.match(/\d+/g);
	if (!match || match.length < 3) return fallback;
	return `${match[0]}, ${match[1]}, ${match[2]}`;
}

function parseContentRgb() {
	return parseRgb(getComputedStyle(document.body).color, "235, 235, 235");
}

function parseSurfaceRgb() {
	return parseRgb(getComputedStyle(document.body).backgroundColor, "23, 23, 23");
}

export function Arcade({ onPlayingChange }: { onPlayingChange: (playing: boolean) => void }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const startRef = useRef<HTMLButtonElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
	const boardsRef = useRef<Board[] | null>(null);
	const indexRef = useRef(0);
	const playingRef = useRef(false);
	const scoreRef = useRef(0);
	const highScoreRef = useRef(0);
	const livesRef = useRef(0);
	const gameOverRef = useRef(false);
	const slideAtRef = useRef(0);

	const [playing, setPlaying] = useState(false);
	const [score, setScore] = useState(0);
	const [highScore, setHighScore] = useState(0);
	const [lives, setLives] = useState(3);
	const [gameOver, setGameOver] = useState(false);
	const [mode, setMode] = useState<ArcadeMode>("mid");
	const [slide, setSlide] = useState<{ index: number; dir: 1 | -1 }>({
		index: 0,
		dir: 1,
	});
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);

	indexRef.current = slide.index;
	playingRef.current = playing;

	const game = GRID_GAMES[slide.index] ?? GRID_GAMES[0]!;

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		const boards: Board[] = [];
		for (let i = 0; i < GRID_GAMES.length; i++) {
			const canvas = canvasRefs.current[i];
			const ctx = canvas?.getContext("2d");
			const spec = GRID_GAMES[i];
			if (!canvas || !ctx || !spec) return;
			boards.push({
				game: spec,
				arcade: spec.create(),
				canvas,
				ctx,
				bubbleAt: null,
			});
		}
		boardsRef.current = boards;

		const gridCanvas = document.createElement("canvas");
		const gridCtx = gridCanvas.getContext("2d");

		let raf = 0;
		let cols = 0;
		let rows = 0;
		let width = 0;
		let height = 0;
		let stamp = new Float32Array(0);
		let rgb = parseContentRgb();
		let surfaceRgb = parseSurfaceRgb();
		let lastFrame = 0;

		const drawGrid = () => {
			if (!gridCtx || width <= 0 || height <= 0) return;
			const dpr = window.devicePixelRatio || 1;
			gridCanvas.width = Math.floor(width * dpr);
			gridCanvas.height = Math.floor(height * dpr);
			gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
			gridCtx.lineWidth = 1;
			gridCtx.strokeStyle = `rgba(${rgb}, ${BORDER_OPACITY})`;
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < cols; x++) {
					gridCtx.strokeRect(x * PITCH + 0.5, y * PITCH + 0.5, CELL - 1, CELL - 1);
				}
			}
		};

		const start = () => {
			if (raf || document.hidden || width <= 0 || height <= 0) return;
			lastFrame = 0;
			raf = requestAnimationFrame(draw);
		};

		const layout = () => {
			const rect = root.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			if (width <= 0 || height <= 0) return;

			const dpr = window.devicePixelRatio || 1;
			const nextCols = Math.ceil(width / PITCH);
			const nextRows = Math.ceil(height / PITCH);

			for (const board of boards) {
				board.canvas.width = Math.floor(width * dpr);
				board.canvas.height = Math.floor(height * dpr);
				board.canvas.style.width = `${width}px`;
				board.canvas.style.height = `${height}px`;
				board.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				board.arcade.resize(nextCols, nextRows);
			}

			cols = nextCols;
			rows = nextRows;
			drawGrid();
			start();
		};

		const paint = (board: Board, width: number, height: number) => {
			const { ctx, arcade } = board;
			const dim = arcade.controlled() ? 1 : board.game.idleDim;
			if (stamp.length === cols * rows) stamp.fill(0);
			else stamp = new Float32Array(cols * rows);
			arcade.stamp(stamp, cols, rows);

			const fade = arcade.fade();
			ctx.clearRect(0, 0, width, height);

			const peak = PEAK_OPACITY * dim;
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < cols; x++) {
					const fillOpacity = (stamp[y * cols + x] ?? 0) * peak;
					if (fillOpacity > 0.02) {
						ctx.fillStyle = `rgba(${rgb}, ${fillOpacity})`;
						ctx.fillRect(x * PITCH, y * PITCH, CELL, CELL);
					}
				}
			}

			if (fade > 0 && gridCanvas.width > 0) {
				ctx.globalAlpha = fade;
				ctx.drawImage(gridCanvas, 0, 0, width, height);
				ctx.globalAlpha = 1;
			}

			for (const sprite of arcade.sprites()) {
				const opacity = sprite.alpha * dim * SPRITE_OPACITY;
				if (opacity <= 0.02) continue;
				drawSprite(ctx, sprite, `rgba(${rgb}, ${opacity})`);
			}

			const bubble = arcade.speechBubble();
			if (!bubble) {
				board.bubbleAt = null;
				return;
			}

			const target = { x: bubble.x * PITCH, y: bubble.y * PITCH };
			board.bubbleAt = !board.bubbleAt
				? target
				: {
						x: board.bubbleAt.x + (target.x - board.bubbleAt.x) * BUBBLE_EASE,
						y: board.bubbleAt.y + (target.y - board.bubbleAt.y) * BUBBLE_EASE,
					};

			drawSpeechBubble(
				ctx,
				bubble.text,
				board.bubbleAt.x,
				board.bubbleAt.y,
				CELL,
				{ width, height },
				bubble.alpha * BUBBLE_OPACITY * dim,
				{ fg: `rgb(${rgb})`, bg: `rgb(${surfaceRgb})` },
			);
		};

		function draw(time: number) {
			if (document.hidden || width <= 0 || height <= 0) {
				raf = 0;
				return;
			}
			raf = requestAnimationFrame(draw);
			if (time - lastFrame < FRAME_MS) return;
			const dt = lastFrame ? time - lastFrame : FRAME_MS;
			lastFrame = time;

			const current = indexRef.current;
			const controlled = playingRef.current;
			const sliding = time - slideAtRef.current < SLIDE_MS;

			for (let i = 0; i < boards.length; i++) {
				const board = boards[i];
				if (!board) continue;
				if (controlled && i !== current) continue;
				board.arcade.step(dt);
				if (i === current || sliding) paint(board, width, height);
			}

			const active = boards[current];
			if (!active || !controlled) return;

			const nextScore = active.arcade.score();
			if (nextScore !== scoreRef.current) {
				scoreRef.current = nextScore;
				setScore(nextScore);
			}
			const nextHigh = active.arcade.highScore();
			if (nextHigh !== highScoreRef.current) {
				highScoreRef.current = nextHigh;
				setHighScore(nextHigh);
			}
			const nextLives = active.arcade.lives();
			if (nextLives !== livesRef.current) {
				livesRef.current = nextLives;
				setLives(nextLives);
			}
			const nextOver = active.arcade.gameOver();
			if (nextOver !== gameOverRef.current) {
				gameOverRef.current = nextOver;
				setGameOver(nextOver);
			}
		}

		layout();

		document.addEventListener("visibilitychange", start);

		const resizeObserver = new ResizeObserver(layout);
		resizeObserver.observe(root);

		const themeObserver = new MutationObserver(() => {
			const next = parseContentRgb();
			surfaceRgb = parseSurfaceRgb();
			if (next === rgb) return;
			rgb = next;
			drawGrid();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["style", "class", "data-theme"],
		});

		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener("visibilitychange", start);
			resizeObserver.disconnect();
			themeObserver.disconnect();
			boardsRef.current = null;
		};
	}, []);

	const takeControl = useCallback(() => {
		const board = boardsRef.current?.[indexRef.current];
		board?.arcade.setMode(mode);
		board?.arcade.takeControl();
		scoreRef.current = 0;
		highScoreRef.current = board?.arcade.highScore() ?? 0;
		livesRef.current = board?.arcade.lives() ?? 0;
		gameOverRef.current = false;
		setScore(0);
		setHighScore(highScoreRef.current);
		setLives(livesRef.current);
		setGameOver(false);
		returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setPlaying(true);
		onPlayingChange(true);
	}, [mode, onPlayingChange]);

	const pickMode = useCallback((next: ArcadeMode) => {
		boardsRef.current?.[indexRef.current]?.arcade.setMode(next);
		setMode(next);
	}, []);

	const releaseControl = useCallback(() => {
		boardsRef.current?.[indexRef.current]?.arcade.releaseControl();
		scoreRef.current = 0;
		gameOverRef.current = false;
		setScore(0);
		setGameOver(false);
		setPlaying(false);
		onPlayingChange(false);
	}, [onPlayingChange]);

	useEffect(() => {
		slideAtRef.current = performance.now();
	}, [slide.index]);

	const showGame = useCallback((next: number) => {
		if (next === indexRef.current) return;
		setSlide({
			index: next,
			dir: next > indexRef.current ? 1 : -1,
		});
	}, []);

	useEffect(() => {
		if (playing || hovered || focused || GRID_GAMES.length < 2) return;

		const id = window.setInterval(() => {
			if (document.hidden || !rootRef.current?.offsetParent) return;
			setSlide((current) => stepSlider(current.index, current.dir, GRID_GAMES.length));
		}, SLIDE_HOLD_MS);
		return () => window.clearInterval(id);
	}, [playing, hovered, focused, slide.index]);

	useEffect(() => {
		if (!playing) {
			const previous = returnFocusRef.current;
			if (previous) (previous.isConnected ? previous : startRef.current)?.focus();
			returnFocusRef.current = null;
			return;
		}

		const root = rootRef.current;
		root?.focus();
		const onWheel = (event: WheelEvent) => event.preventDefault();
		root?.addEventListener("wheel", onWheel, { passive: false });

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
			const active = document.activeElement;
			if (active !== root && !(active instanceof Node && root?.contains(active))) return;

			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				releaseControl();
				return;
			}
			if (active instanceof Element && active.closest("button")) return;

			const handled = boardsRef.current?.[indexRef.current]?.arcade.keyDown(event.key, event.repeat);
			if (handled) {
				event.preventDefault();
				event.stopPropagation();
			}
		};

		const onKeyUp = (event: KeyboardEvent) => {
			boardsRef.current?.[indexRef.current]?.arcade.keyUp(event.key);
		};

		const onBlur = () => {
			boardsRef.current?.[indexRef.current]?.arcade.blur();
		};

		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			root?.removeEventListener("wheel", onWheel);
		};
	}, [playing, releaseControl]);

	return (
		<div
			ref={rootRef}
			tabIndex={playing ? 0 : -1}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
			onPointerDown={(event) => {
				if (!playing || event.button !== 0 || (event.target instanceof Element && event.target.closest("button")))
					return;
				event.preventDefault();
				const root = rootRef.current;
				root?.focus();
				const rect = root?.getBoundingClientRect();
				const xRatio = rect && rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
				boardsRef.current?.[indexRef.current]?.arcade.pointerDown(xRatio);
			}}
			aria-label={playing ? game.playLabel : undefined}
			className={
				playing
					? "absolute inset-0 z-20 touch-none overflow-hidden bg-frame outline-none"
					: "group pointer-events-auto absolute inset-x-0 top-0 z-0 h-48"
			}
		>
			<div
				className={
					playing
						? "absolute inset-0 overflow-hidden"
						: "absolute inset-0 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_65%,transparent_100%)]"
				}
			>
				<div
					className={`flex h-full motion-reduce:transition-none ${
						playing ? "" : "transition-transform duration-700 ease-in-out"
					}`}
					style={{ transform: `translateX(-${slide.index * 100}%)` }}
				>
					{GRID_GAMES.map((item, i) => (
						<div key={item.id} className="relative h-full w-full min-w-full shrink-0">
							<canvas
								ref={(el) => {
									canvasRefs.current[i] = el;
								}}
								className="absolute inset-0 h-full w-full"
								aria-hidden
							/>
						</div>
					))}
				</div>
			</div>

			{playing ? (
				<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-between gap-3 px-3 py-2 font-mono text-[11px] tracking-[0.14em] text-ink/50">
					<span>
						score {String(score).padStart(5, "0")}
						{highScore > 0 ? (
							<span className="ml-3 text-ink/35">hi {String(highScore).padStart(5, "0")}</span>
						) : null}
						{game.lives ? (
							<span className="ml-3 text-ink/35">{lives > 0 ? "•".repeat(lives) : "game over"}</span>
						) : gameOver ? (
							<span className="ml-3 text-ink/35">game over</span>
						) : null}
					</span>
					<div className="pointer-events-auto flex justify-center gap-1">
						{ARCADE_MODES.map((id) => {
							const on = mode === id;
							return (
								<button
									key={id}
									type="button"
									aria-pressed={on}
									onClick={() => pickMode(id)}
									className={`cursor-pointer border px-2 py-1 focus-visible:outline focus-visible:outline-ink ${
										on
											? "border-ink/40 bg-ink/10 text-ink"
											: "border-ink/10 text-ink/40 hover:border-ink/25 hover:text-ink/70"
									}`}
								>
									{id}
								</button>
							);
						})}
					</div>
					<div className="flex justify-end">
						<button
							type="button"
							onClick={releaseControl}
							className="pointer-events-auto cursor-pointer border border-ink/20 bg-frame/70 px-2 py-1 text-ink/70 hover:border-ink/40 hover:text-ink"
						>
							<span className="text-ink/35">[</span> release <span className="text-ink/35">]</span>
						</button>
					</div>
				</div>
			) : (
				<>
					<div className="pointer-events-none absolute inset-0 z-10 grid place-items-center opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
						<button
							ref={startRef}
							type="button"
							onClick={takeControl}
							className="pointer-events-auto flex cursor-pointer items-center gap-2 border border-ink/25 bg-frame/80 px-3 py-1.5 font-mono text-[11px] tracking-[0.16em] text-ink/85 shadow-lg backdrop-blur-sm hover:border-ink/45 hover:bg-ink/10 hover:text-ink focus-visible:outline focus-visible:outline-ink"
						>
							<span className="text-ink/40">[</span>
							take control
							<span className="text-ink/25">·</span>
							{game.label}
							<span
								className="inline-block h-3 w-1.5 bg-ink/75 motion-safe:group-hover:animate-pulse"
								aria-hidden
							/>
							<span className="text-ink/40">]</span>
						</button>
					</div>
					{GRID_GAMES.length > 1 ? (
						<div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 flex justify-center">
							{GRID_GAMES.map((item, i) => {
								const on = i === slide.index;
								return (
									<button
										key={item.id}
										type="button"
										aria-label={item.label}
										aria-pressed={on}
										onClick={() => showGame(i)}
										className="pointer-events-auto flex h-6 w-6 cursor-pointer items-center justify-center focus-visible:outline focus-visible:outline-ink"
									>
										<span className={`block h-1.5 w-1.5 ${on ? "bg-ink/45" : "bg-ink/15 hover:bg-ink/30"}`} />
									</button>
								);
							})}
						</div>
					) : null}
				</>
			)}
			{playing ? (
				<p className="pointer-events-none absolute inset-x-0 bottom-3 px-3 text-center font-mono text-[11px] text-ink/50">
					{gameOver ? game.overHint : game.playHint} · Esc to release
				</p>
			) : null}
		</div>
	);
}
