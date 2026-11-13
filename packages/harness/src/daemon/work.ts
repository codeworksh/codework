import { Detached } from "@codeworksh/plugin/plugin/daemon";
import { Cause, Effect, Schema, type Scope } from "effect";

const isDetached = Schema.is(Detached);

/**
 * A daemon's single-flight job. `mark` runs it now when it is idle and the space is readable,
 * once more after the run in flight (any number of marks collapse into one rerun), and leaves it
 * dirty when the space is not readable; `wake` runs dirty work when the space is mounted again.
 *
 * A run that fails is logged and not retried: the next mark is the retry. One that fails because
 * the space stopped being readable is dirty again instead.
 */
export interface Work {
	readonly mark: Effect.Effect<void>;
	readonly wake: Effect.Effect<void>;
	/** Neither running nor due to run again: what a handover waits for. */
	readonly settled: Effect.Effect<boolean>;
}

export const make = <E>(input: {
	readonly name: string;
	readonly scope: Scope.Scope;
	readonly readable: Effect.Effect<boolean>;
	readonly run: Effect.Effect<void, E>;
}): Effect.Effect<Work> =>
	Effect.sync(() => {
		const state = { running: false, again: false, dirty: false };

		const detached = (cause: Cause.Cause<unknown>) => isDetached(Cause.squash(cause));

		const once = input.run.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: detached(cause)
						? Effect.sync(() => {
								state.dirty = true;
							})
						: Effect.logWarning(`daemon work ${input.name} failed`, cause),
			),
		);

		const loop: Effect.Effect<void> = Effect.gen(function* () {
			state.dirty = false;
			yield* once;
			if (!state.again) return;
			state.again = false;
			if (yield* input.readable) return yield* loop;
			state.dirty = true;
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					state.running = false;
				}),
			),
		);

		const start = Effect.suspend(() => {
			state.running = true;
			state.dirty = false;
			return Effect.forkIn(loop, input.scope).pipe(Effect.asVoid);
		});

		const mark = Effect.suspend(() => {
			if (state.running) {
				state.again = true;
				return Effect.void;
			}
			return input.readable.pipe(
				Effect.flatMap((readable) => {
					// Re-checked: another mark may have started a run while `readable` was read.
					if (state.running) {
						state.again = true;
						return Effect.void;
					}
					if (readable) return start;
					state.dirty = true;
					return Effect.void;
				}),
			);
		});

		const wake = Effect.suspend(() => (state.dirty && !state.running ? mark : Effect.void));

		return {
			mark,
			wake,
			settled: Effect.sync(() => !state.running && !state.again),
		};
	});
