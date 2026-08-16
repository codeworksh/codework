/*
 * @file Effect boundary for one aikit LLM request.
 *
 * aikit owns provider normalization and emits an AsyncIterable of canonical LLM
 * events. This module owns the lifecycle that aikit cannot see: Effect fiber
 * interruption aborts the transport, while a scoped consumer stays alive long
 * enough to publish aikit's terminal error event durably.
 */

import {
	stream as aikitStream,
	llm,
	type Event as AikitEvent,
	type Message,
	type OpenAIOptions,
} from "@codeworksh/aikit";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import type { SessionSchema } from "../session/schema.ts";
import { LLMEventPublisher } from "./event.ts";
import { Runner } from "./run.ts";

export interface Input {
	readonly sessionId: SessionSchema.ID;
	readonly context: Message.Context;
	readonly provider: string;
	readonly model: string;
}

export interface RequestInput extends Input {
	readonly publisher: LLMEventPublisher.Publisher;
}

export type Open = (
	input: Input,
	signal: AbortSignal,
) => Effect.Effect<AsyncIterable<AikitEvent.LLMMessageEvent>, Runner.ModelNotFoundError | Runner.ProviderTurnError>;

export type Request = (
	input: RequestInput,
) => Effect.Effect<
	LLMEventPublisher.Terminal,
	Runner.ModelNotFoundError | Runner.ProviderTurnError | Runner.LLMStreamError
>;

const runtimeOptions = (input: Input, signal: AbortSignal): OpenAIOptions => ({
	maxTokens: 1_024,
	reasoning: "high",
	providerOptions: { openai: { reasoningSummary: "auto" } },
	timeoutMs: 60_000,
	maxRetries: 0,
	sessionId: input.sessionId,
	signal,
});

/** Resolve the configured model and start aikit's provider stream. */
export const open: Open = Effect.fn("LLM.open")(function* (input, signal) {
	const model = yield* Effect.tryPromise({
		try: () => llm(input.provider, input.model),
		catch: (cause) => new Runner.ProviderTurnError({ provider: input.provider, model: input.model, cause }),
	});
	if (model === undefined) {
		return yield* new Runner.ModelNotFoundError({ provider: input.provider, model: input.model });
	}

	return yield* Effect.try({
		try: () => aikitStream(model, input.context, runtimeOptions(input, signal)),
		catch: (cause) => new Runner.ProviderTurnError({ provider: input.provider, model: input.model, cause }),
	});
});

/**
 * Build a provider request from an opener. Tests use this with deterministic
 * aikit event streams; production uses `open` above.
 */
export const make = (openStream: Open): Request => {
	const request = Effect.fn("LLM.run")(function* (input: RequestInput) {
		/*
		 * Give the transport signal its own closeable scope. Closing it aborts the
		 * signal immediately without closing this request's outer scope, which must
		 * remain alive while the consumer drains and commits aikit's terminal event.
		 */
		const signalScope = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(signalScope, exit));
		const signal = yield* Effect.abortSignal.pipe(Scope.provide(signalScope));
		const abort = Scope.close(signalScope, Exit.void);

		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const iterable = yield* restore(openStream(input, signal)).pipe(Effect.onInterrupt(() => abort));
				const consume = Stream.fromAsyncIterable(
					iterable,
					(cause) => new Runner.ProviderTurnError({ provider: input.provider, model: input.model, cause }),
				).pipe(
					Stream.runForEach(input.publisher.publish),
					Effect.andThen(input.publisher.terminal),
					Effect.interruptible,
				);

				/*
				 * The consumer is deliberately a separate scoped fiber. Interrupting the
				 * owning turn only interrupts its wait, not this consumer. The interrupt
				 * handler aborts aikit's transport; aikit then emits its terminal `error`,
				 * which the same consumer publishes before the parent rethrows the original
				 * interruption. No second iterator can steal or lose that terminal event.
				 */
				const consumer = yield* consume.pipe(Effect.forkScoped({ startImmediately: true }));
				const awaited = yield* restore(Fiber.await(consumer)).pipe(
					Effect.onInterrupt(() => abort),
					Effect.exit,
				);

				if (Exit.isFailure(awaited)) {
					const drained = yield* Fiber.await(consumer);
					if (Exit.isFailure(drained)) return yield* Effect.failCause(drained.cause);
					return yield* Effect.failCause(awaited.cause);
				}

				const completed = awaited.value;
				if (Exit.isFailure(completed)) return yield* Effect.failCause(completed.cause);
				return completed.value;
			}),
		);
	});

	return (input) => request(input).pipe(Effect.scoped);
};

export const run = make(open);

export * as LLM from "./llm.ts";
