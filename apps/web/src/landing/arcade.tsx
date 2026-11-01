import { useCallback, useEffect, useRef, useState } from "react";

import {
	ARCADE_MODES,
	type ArcadeMode,
	createDinoArcade,
	type DinoArcade,
	type DinoSprite,
	type DinoSpriteKind,
	SPRITE_PATHS,
	SPRITE_UNIT,
} from "./dino";

const CELL = 6;
const GAP = 1;
const PITCH = CELL + GAP;
const BORDER_OPACITY = 0.06;
const PEAK_OPACITY = 0.72;
const SPRITE_OPACITY = 0.92;
const BUBBLE_OPACITY = 0.9;
const IDLE_DIM = 0.55;
const BUBBLE_EASE = 0.22;
const FRAME_MS = 33;

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

const spritePaths = new Map<DinoSpriteKind, Path2D>();

function getSpritePath(kind: DinoSpriteKind): Path2D {
	const cached = spritePaths.get(kind);
	if (cached !== undefined) return cached;
	const path = new Path2D(SPRITE_PATHS[kind]);
	spritePaths.set(kind, path);
	return path;
}

function drawSprite(ctx: CanvasRenderingContext2D, sprite: DinoSprite, fill: string) {
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

const JUMP_KEYS = new Set([" ", "Spacebar", "ArrowUp", "w", "W"]);
const DUCK_KEYS = new Set(["ArrowDown", "s", "S"]);

export function Arcade({ onPlayingChange }: { onPlayingChange: (playing: boolean) => void }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const startRef = useRef<HTMLButtonElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const arcadeRef = useRef<DinoArcade | null>(null);
	const playingRef = useRef(false);
	const scoreRef = useRef(0);
	const highScoreRef = useRef(0);
	const gameOverRef = useRef(false);

	const [playing, setPlaying] = useState(false);
	const [score, setScore] = useState(0);
	const [highScore, setHighScore] = useState(0);
	const [gameOver, setGameOver] = useState(false);
	const [mode, setMode] = useState<ArcadeMode>("mid");

	playingRef.current = playing;

	useEffect(() => {
		const root = rootRef.current;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!root || !canvas || !ctx) return;

		const arcade = createDinoArcade();
		arcadeRef.current = arcade;

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
		let bubbleAt: { x: number; y: number } | null = null;

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

			canvas.width = Math.floor(width * dpr);
			canvas.height = Math.floor(height * dpr);
			canvas.style.width = `${width}px`;
			canvas.style.height = `${height}px`;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			arcade.resize(nextCols, nextRows);

			cols = nextCols;
			rows = nextRows;
			drawGrid();
			start();
		};

		const paint = () => {
			const dim = arcade.controlled() ? 1 : IDLE_DIM;
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
				bubbleAt = null;
				return;
			}

			const target = { x: bubble.x * PITCH, y: bubble.y * PITCH };
			bubbleAt = !bubbleAt
				? target
				: {
						x: bubbleAt.x + (target.x - bubbleAt.x) * BUBBLE_EASE,
						y: bubbleAt.y + (target.y - bubbleAt.y) * BUBBLE_EASE,
					};

			drawSpeechBubble(
				ctx,
				bubble.text,
				bubbleAt.x,
				bubbleAt.y,
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

			arcade.step(dt);
			paint();

			if (!playingRef.current) return;

			const nextScore = arcade.score();
			if (nextScore !== scoreRef.current) {
				scoreRef.current = nextScore;
				setScore(nextScore);
			}
			const nextHigh = arcade.highScore();
			if (nextHigh !== highScoreRef.current) {
				highScoreRef.current = nextHigh;
				setHighScore(nextHigh);
			}
			const nextOver = arcade.gameOver();
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
			arcadeRef.current = null;
		};
	}, []);

	const takeControl = useCallback(() => {
		const arcade = arcadeRef.current;
		arcade?.setMode(mode);
		arcade?.takeControl();
		scoreRef.current = 0;
		gameOverRef.current = false;
		setScore(0);
		setGameOver(false);
		returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setPlaying(true);
		onPlayingChange(true);
	}, [mode, onPlayingChange]);

	const pickMode = useCallback((next: ArcadeMode) => {
		arcadeRef.current?.setMode(next);
		setMode(next);
	}, []);

	const releaseControl = useCallback(() => {
		arcadeRef.current?.releaseControl();
		scoreRef.current = 0;
		gameOverRef.current = false;
		setScore(0);
		setGameOver(false);
		setPlaying(false);
		onPlayingChange(false);
	}, [onPlayingChange]);

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
			if (JUMP_KEYS.has(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				if (!event.repeat) arcadeRef.current?.jump();
				return;
			}
			if (DUCK_KEYS.has(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				arcadeRef.current?.setDuck(true);
			}
		};

		const onKeyUp = (event: KeyboardEvent) => {
			if (DUCK_KEYS.has(event.key)) {
				arcadeRef.current?.setDuck(false);
			}
		};

		const onBlur = () => {
			arcadeRef.current?.setDuck(false);
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
			onPointerDown={(event) => {
				if (!playing || event.button !== 0 || (event.target instanceof Element && event.target.closest("button")))
					return;
				event.preventDefault();
				rootRef.current?.focus();
				arcadeRef.current?.jump();
			}}
			aria-label={playing ? "Dino runner. Space or Up to jump, Down to duck, Escape to release." : undefined}
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
				<canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
			</div>

			{playing ? (
				<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-between gap-3 px-3 py-2 font-mono text-[11px] tracking-[0.14em] text-ink/50">
					<span>
						score {String(score).padStart(5, "0")}
						{highScore > 0 ? (
							<span className="ml-3 text-ink/35">hi {String(highScore).padStart(5, "0")}</span>
						) : null}
						{gameOver ? <span className="ml-3 text-ink/35">game over</span> : null}
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
						dino
						<span
							className="inline-block h-3 w-1.5 bg-ink/75 motion-safe:group-hover:animate-pulse"
							aria-hidden
						/>
						<span className="text-ink/40">]</span>
					</button>
				</div>
			)}
			{playing ? (
				<p className="pointer-events-none absolute inset-x-0 bottom-3 px-3 text-center font-mono text-[11px] text-ink/50">
					{gameOver ? "Space or tap to restart" : "Space / ↑ / tap to jump · ↓ to duck"} · Esc to release
				</p>
			) : null}
		</div>
	);
}
