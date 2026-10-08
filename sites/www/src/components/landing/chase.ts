import { MARK } from "./wordmark";

type Point = { x: number; y: number };
export type Pellet = Point & { id: string };
export const chaseCount = (width: number) => (width < 360 ? 1 : width < 640 ? 2 : 5);
export type Obstacle = { left: number; top: number; right: number; bottom: number };

/** A four-direction chase through the clear spaces between hero content. */
export class Chase {
	x = 20;
	y = 78;
	angle = 0;
	private target: Pellet | null = null;
	private route: Point[] = [];
	private bite = -Infinity;
	private lastTime: number | null = null;
	private readonly cols: number;
	private readonly rows: number;
	private readonly blocked: boolean[];

	constructor(
		private readonly width: number,
		private readonly height: number,
		obstacles: readonly Obstacle[],
		start: Point,
		readonly eaten: Map<string, number>,
	) {
		this.cols = Math.max(2, Math.floor((width - 40) / 22));
		this.rows = Math.max(2, Math.floor((height - 40) / 22));
		this.stepX = (width - 40) / (this.cols - 1);
		this.stepY = (height - 40) / (this.rows - 1);
		const clearance = width < 640 ? 14 : 20;
		this.blocked = Array.from({ length: this.cols * this.rows }, (_, index) => {
			const point = this.point(index);
			return obstacles.some(
				(box) =>
					point.x > box.left - clearance &&
					point.x < box.right + clearance &&
					point.y > box.top - clearance &&
					point.y < box.bottom + clearance,
			);
		});
		let nearest = Infinity;
		for (let index = 0; index < this.blocked.length; index++) {
			if (this.blocked[index]) continue;
			const point = this.point(index);
			const distance = Math.hypot(point.x - start.x, point.y - start.y);
			if (distance < nearest) {
				nearest = distance;
				this.x = point.x;
				this.y = point.y;
			}
		}
	}
	private readonly stepX: number;
	private readonly stepY: number;
	get targetId() {
		return this.target?.id;
	}
	private point(index: number): Point {
		return { x: 20 + (index % this.cols) * this.stepX, y: 20 + Math.floor(index / this.cols) * this.stepY };
	}
	private index(point: Point) {
		const col = Math.max(0, Math.min(this.cols - 1, Math.round((point.x - 20) / this.stepX)));
		const row = Math.max(0, Math.min(this.rows - 1, Math.round((point.y - 20) / this.stepY)));
		return row * this.cols + col;
	}
	private findRoute(pellets: readonly Pellet[], reserved: ReadonlySet<string>) {
		const targets = new Map<number, Pellet>();
		for (const pellet of pellets)
			if (!this.eaten.has(pellet.id) && !reserved.has(pellet.id) && !this.blocked[this.index(pellet)])
				targets.set(this.index(pellet), pellet);
		const start = this.index(this);
		const previous = new Int32Array(this.blocked.length).fill(-1);
		previous[start] = start;
		const queue = [start];
		for (let head = 0; head < queue.length; head++) {
			const node = queue[head]!;
			const target = targets.get(node);
			if (target) {
				this.target = {
					...target,
					x: Math.max(20, Math.min(this.width - 20, target.x)),
					y: Math.max(20, Math.min(this.height - 20, target.y)),
				};
				const route: Point[] = [this.target];
				for (let at = node; at !== start; at = previous[at]!) route.unshift(this.point(at));
				this.route = route;
				return;
			}
			const col = node % this.cols,
				row = Math.floor(node / this.cols);
			const neighbors = [
				col > 0 ? node - 1 : -1,
				col + 1 < this.cols ? node + 1 : -1,
				row > 0 ? node - this.cols : -1,
				row + 1 < this.rows ? node + this.cols : -1,
			];
			for (const next of neighbors)
				if (next >= 0 && !this.blocked[next] && previous[next] === -1) {
					previous[next] = node;
					queue.push(next);
				}
		}
	}
	update(time: number, pellets: readonly Pellet[], reserved: ReadonlySet<string>) {
		const dt = this.lastTime === null ? 0 : Math.min(0.05, Math.max(0, time - this.lastTime));
		this.lastTime = time;
		for (const [id, until] of this.eaten) if (time >= until) this.eaten.delete(id);
		if (!this.target) this.findRoute(pellets, reserved);
		const goal = this.route[0];
		if (!goal) return;
		const dx = goal.x - this.x,
			dy = goal.y - this.y,
			distance = Math.hypot(dx, dy);
		const speed = this.width < 640 ? 70 : 110;
		if (distance > 0.1) {
			this.angle = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : Math.PI) : dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
			const step = Math.min(1, (speed * dt) / distance);
			this.x += dx * step;
			this.y += dy * step;
		}
		if (distance <= speed * dt + 1) {
			this.route.shift();
			if (this.route.length === 0 && this.target) {
				this.eaten.set(this.target.id, time + 9);
				this.bite = time;
				this.target = null;
			}
		}
	}

	draw(ctx: CanvasRenderingContext2D, time: number, dpr: number, body: string, accent: string) {
		const size = this.width < 640 ? 28 : 36;
		const unit = (size * dpr) / MARK.width;
		ctx.save();
		ctx.translate(Math.round(this.x * dpr), Math.round(this.y * dpr));
		ctx.rotate(this.angle);
		ctx.fillStyle = body;
		const open = Math.sin(time * 14) > 0;
		for (let row = 0; row < MARK.height; row++)
			for (let col = 0; col < MARK.width; col++) {
				if (MARK.rows[row]?.[col] !== "1" || (open && col >= 12 && (row < 3 || row >= 12))) continue;
				const x = Math.round((col - MARK.width / 2) * unit);
				const y = Math.round((row - MARK.height / 2) * unit);
				ctx.fillRect(
					x,
					y,
					Math.round((col + 1 - MARK.width / 2) * unit) - x,
					Math.round((row + 1 - MARK.height / 2) * unit) - y,
				);
			}
		ctx.fillStyle = accent;
		ctx.fillRect(4.5 * unit, -1.5 * unit, 3 * unit, 3 * unit);
		if (time - this.bite < 0.3) {
			const spread = 4 + (time - this.bite) * 30;
			for (const dy of [-1, 1]) ctx.fillRect((size / 2 + spread) * dpr, dy * spread * dpr, 2 * dpr, 2 * dpr);
		}
		ctx.restore();
	}
}
