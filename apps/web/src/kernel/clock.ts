/** A `useSyncExternalStore` clock: one timer for every subscriber, its snapshot cached between ticks. */
export interface Clock {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => number;
}

/** Epoch ms floored to `periodMs`, advancing on each wall-clock boundary so every subscriber updates in the same frame. */
function tick(periodMs: number): Clock {
	const read = () => Math.floor(Date.now() / periodMs) * periodMs;
	let value = read();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<() => void>();
	const schedule = () => {
		timer = setTimeout(
			() => {
				timer = undefined;
				const next = read();
				if (next !== value) {
					value = next;
					for (const listener of listeners) listener();
				}
				// A listener may unsubscribe (stopping the clock) or resubscribe (arming a new timer) while notified.
				if (listeners.size > 0 && timer === undefined) schedule();
			},
			periodMs - (Date.now() % periodMs),
		);
	};
	return {
		subscribe: (listener) => {
			if (listeners.size === 0) {
				value = read();
				schedule();
			}
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				clearTimeout(timer);
				timer = undefined;
			};
		},
		getSnapshot: () => {
			if (timer === undefined) value = read();
			return value;
		},
	};
}

export const secondTick = tick(1000);
export const minuteTick = tick(60_000);
