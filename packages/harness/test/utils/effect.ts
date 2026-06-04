import { it as vitestIt, type TestOptions } from "vite-plus/test";
import { Cause, Effect, Exit, Layer } from "effect";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>);

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value));

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
	Effect.gen(function* () {
		const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit);
		if (Exit.isFailure(exit)) {
			for (const err of Cause.prettyErrors(exit.cause)) {
				yield* Effect.logError(err);
			}
		}
		return yield* exit;
	}).pipe(Effect.runPromise);

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => {
	const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt(name, () => run(value, testLayer), opts)
			: opts !== undefined
				? vitestIt(name, opts, () => run(value, testLayer))
				: vitestIt(name, () => run(value, testLayer));

	effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt.only(name, () => run(value, testLayer), opts)
			: opts !== undefined
				? vitestIt.only(name, opts, () => run(value, testLayer))
				: vitestIt.only(name, () => run(value, testLayer));

	effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt.skip(name, () => run(value, testLayer), opts)
			: opts !== undefined
				? vitestIt.skip(name, opts, () => run(value, testLayer))
				: vitestIt.skip(name, () => run(value, testLayer));

	const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt(name, () => run(value, liveLayer), opts)
			: opts !== undefined
				? vitestIt(name, opts, () => run(value, liveLayer))
				: vitestIt(name, () => run(value, liveLayer));

	live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt.only(name, () => run(value, liveLayer), opts)
			: opts !== undefined
				? vitestIt.only(name, opts, () => run(value, liveLayer))
				: vitestIt.only(name, () => run(value, liveLayer));

	live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
		typeof opts === "number"
			? vitestIt.skip(name, () => run(value, liveLayer), opts)
			: opts !== undefined
				? vitestIt.skip(name, opts, () => run(value, liveLayer))
				: vitestIt.skip(name, () => run(value, liveLayer));

	return { effect, live };
};

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer;

export const it = make(testEnv, liveEnv);

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
	make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv));
