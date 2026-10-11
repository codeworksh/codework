import { useEffect, useRef, useState } from "react";
import { drawMark } from "./chase";

// # wall, . pellet, P player start, G ghost start, space open floor.
const MAZE = [
	"###################",
	"#P.......#.......G#",
	"#.##.###.#.###.##.#",
	"#.................#",
	"#.##.#.#####.#.##.#",
	"#....#...#...#....#",
	"####.### # ###.####",
	"#........G........#",
	"#.##.###.#.###.##.#",
	"#....#.......#....#",
	"###################",
];
const COLS = MAZE[0]!.length;
const ROWS = MAZE.length;
const GHOST = ["0011100", "0111110", "1101011", "1111111", "1111111", "1111111", "1010101"];
const KEYS: Record<string, Direction> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
	a: [-1, 0],
	d: [1, 0],
	w: [0, -1],
	s: [0, 1],
};

type Direction = readonly [number, number];
type Status = "ready" | "playing" | "caught" | "clear";
type Mover = { col: number; row: number; dir: Direction; progress: number };

const STILL: Direction = [0, 0];
const DIRECTIONS: readonly Direction[] = [
	[-1, 0],
	[1, 0],
	[0, -1],
	[0, 1],
];
const open = (col: number, row: number) => MAZE[row]?.[col] !== undefined && MAZE[row]![col] !== "#";
const position = ({ col, row, dir, progress }: Mover) => ({ x: col + dir[0] * progress, y: row + dir[1] * progress });
const starts = (char: string) =>
	MAZE.flatMap((line, row) => line.split("").flatMap((cell, col) => (cell === char ? [{ col, row }] : [])));

/** Advance along the grid, turning only at cell centres; `choose` picks the next direction there. */
function step(mover: Mover, distance: number, choose: (mover: Mover) => Direction) {
	if (mover.dir === STILL) mover.dir = choose(mover);
	mover.progress += distance;
	while (mover.dir !== STILL && mover.progress >= 1) {
		mover.col += mover.dir[0];
		mover.row += mover.dir[1];
		mover.progress -= 1;
		mover.dir = choose(mover);
	}
	if (mover.dir === STILL) mover.progress = 0;
}

/** A small maze for the 404 page: arrow keys or swipes steer the C mark, ghosts give chase. */
export function Arcade() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [status, setStatus] = useState<Status>("ready");
	const [score, setScore] = useState(0);

	useEffect(() => {
		const canvas = canvasRef.current!;
		const ctx = canvas.getContext("2d")!;
		const style = getComputedStyle(document.documentElement);
		const token = (name: string) => style.getPropertyValue(`--t-field-${name}`).trim();

		let state: Status = "ready";
		let want: Direction = STILL;
		let pellets = new Set<string>();
		let player: Mover = { col: 0, row: 0, dir: STILL, progress: 0 };
		let ghosts: Mover[] = [];
		let started = 0;
		let bite = -Infinity;
		let cell = 24;
		let dpr = 1;

		const reset = () => {
			pellets = new Set(starts(".").map(({ col, row }) => `${col},${row}`));
			player = { ...starts("P")[0]!, dir: STILL, progress: 0 };
			ghosts = starts("G").map((start) => ({ ...start, dir: STILL, progress: 0 }));
			want = STILL;
			setScore(0);
		};
		const report = (next: Status) => {
			state = next;
			setStatus(next);
		};

		const steerPlayer = (mover: Mover): Direction => {
			if (open(mover.col + want[0], mover.row + want[1])) return want;
			return open(mover.col + mover.dir[0], mover.row + mover.dir[1]) ? mover.dir : STILL;
		};
		const steerGhost = (mover: Mover): Direction => {
			const target = position(player);
			const options = DIRECTIONS.filter(
				([dx, dy]) => open(mover.col + dx, mover.row + dy) && !(dx === -mover.dir[0] && dy === -mover.dir[1]),
			);
			if (options.length === 0) return [-mover.dir[0], -mover.dir[1]];
			if (Math.random() < 0.25) return options[Math.floor(Math.random() * options.length)]!;
			const distance = ([dx, dy]: Direction) => Math.hypot(mover.col + dx - target.x, mover.row + dy - target.y);
			return options.reduce((best, option) => (distance(option) < distance(best) ? option : best));
		};

		const steer = (dir: Direction) => {
			if (state !== "playing") {
				reset();
				started = performance.now() / 1000;
				report("playing");
			}
			want = dir;
			// Reversing never waits for the next cell centre.
			if (player.dir !== STILL && dir[0] === -player.dir[0] && dir[1] === -player.dir[1]) {
				player.col += player.dir[0];
				player.row += player.dir[1];
				player.dir = dir;
				player.progress = 1 - player.progress;
			}
		};

		const onKey = (event: KeyboardEvent) => {
			const dir = KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
			if (!dir || event.metaKey || event.ctrlKey || event.altKey) return;
			event.preventDefault();
			steer(dir);
		};
		let touch: { x: number; y: number } | null = null;
		const onTouchStart = (event: TouchEvent) => {
			const point = event.touches[0]!;
			touch = { x: point.clientX, y: point.clientY };
		};
		const onTouchEnd = (event: TouchEvent) => {
			const point = event.changedTouches[0]!;
			if (!touch) return;
			const dx = point.clientX - touch.x,
				dy = point.clientY - touch.y;
			touch = null;
			if (Math.max(Math.abs(dx), Math.abs(dy)) < 16) return;
			steer(Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]);
		};

		const resize = () => {
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			cell = Math.min(28, Math.floor(canvas.parentElement!.clientWidth / COLS));
			canvas.style.width = `${cell * COLS}px`;
			canvas.style.height = `${cell * ROWS}px`;
			canvas.width = cell * COLS * dpr;
			canvas.height = cell * ROWS * dpr;
		};

		let last: number | null = null;
		let frame = 0;
		const tick = (now: number) => {
			const time = now / 1000;
			const dt = last === null ? 0 : Math.min(0.05, time - last);
			last = time;

			if (state === "playing") {
				step(player, 7 * dt, steerPlayer);
				const at = position(player);
				const key = `${Math.round(at.x)},${Math.round(at.y)}`;
				if (pellets.delete(key)) {
					bite = time;
					setScore((value) => value + 10);
					if (pellets.size === 0) report("clear");
				}
				// Ghosts hold their start for a beat so the first move is never a loss.
				if (time - started > 1.5) for (const ghost of ghosts) step(ghost, 5 * dt, steerGhost);
				if (ghosts.some((ghost) => Math.hypot(position(ghost).x - at.x, position(ghost).y - at.y) < 0.6))
					report("caught");
			}

			const unit = cell * dpr;
			ctx.fillStyle = token("bg");
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = token("dim");
			MAZE.forEach((line, row) =>
				line.split("").forEach((char, col) => char === "#" && ctx.fillRect(col * unit, row * unit, unit, unit)),
			);
			ctx.fillStyle = token("mid");
			const dot = Math.max(2, Math.round(unit / 7));
			for (const key of pellets) {
				const [col, row] = key.split(",").map(Number) as [number, number];
				ctx.fillRect((col + 0.5) * unit - dot / 2, (row + 0.5) * unit - dot / 2, dot, dot);
			}
			ctx.fillStyle = token("crest");
			const pixel = (unit * 0.8) / GHOST.length;
			for (const ghost of ghosts) {
				const { x, y } = position(ghost);
				const left = (x + 0.1) * unit,
					top = (y + 0.1) * unit;
				GHOST.forEach((bits, row) =>
					bits
						.split("")
						.forEach(
							(bit, col) => bit === "1" && ctx.fillRect(left + col * pixel, top + row * pixel, pixel, pixel),
						),
				);
			}
			const at = position(player);
			const [dx, dy] = player.dir === STILL ? want : player.dir;
			drawMark(ctx, {
				x: (at.x + 0.5) * cell,
				y: (at.y + 0.5) * cell,
				size: cell * 0.85,
				angle: dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx),
				time: state === "playing" ? time : 0,
				bite,
				dpr,
				body: token("lit"),
				accent: token("crest"),
			});
			frame = requestAnimationFrame(tick);
		};

		reset();
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(canvas.parentElement!);
		window.addEventListener("keydown", onKey);
		canvas.addEventListener("touchstart", onTouchStart, { passive: true });
		canvas.addEventListener("touchend", onTouchEnd, { passive: true });
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("keydown", onKey);
			canvas.removeEventListener("touchstart", onTouchStart);
			canvas.removeEventListener("touchend", onTouchEnd);
		};
	}, []);

	const message = {
		ready: "Press an arrow key or swipe to play",
		playing: "Eat every pellet. Dodge the ghosts.",
		caught: "Caught! Press an arrow key to try again",
		clear: "All clear! Press an arrow key to play again",
	}[status];

	return (
		<div>
			<div className="flex justify-center">
				<canvas ref={canvasRef} className="block touch-none" aria-label="Maze mini game" />
			</div>
			<p className="mt-4 flex justify-between gap-4 font-mono text-xs text-text-muted">
				<span>{message}</span>
				<span className="text-text">{String(score).padStart(4, "0")}</span>
			</p>
		</div>
	);
}
