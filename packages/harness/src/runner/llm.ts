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
	type Model,
	type OpenAIOptions,
} from "@codeworksh/aikit";
import * as AikitFailure from "@codeworksh/aikit/failure";
import { Duration, Effect, Exit, Fiber, Scope, Stream } from "effect";
import type { SessionSchema } from "../session/schema.ts";
import type { State } from "../state/state.ts";
import { LLMEventPublisher } from "./event.ts";
import { Runner } from "./run.ts";

export interface Input {
	readonly sessionId: SessionSchema.ID;
	readonly context: Message.Context;
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly options?: State.RequestOptions;
}

export interface RequestInput extends Input {
	readonly publisher: LLMEventPublisher.Publisher;
}

export type Open = (
	input: Input,
	signal: AbortSignal,
) => Effect.Effect<
	AsyncIterable<AikitEvent.LLMMessageEvent>,
	Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError
>;

export type Request = (
	input: RequestInput,
) => Effect.Effect<
	LLMEventPublisher.Terminal,
	Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError | Runner.LLMStreamError
>;

const runtimeOptions = (input: Input, signal: AbortSignal): OpenAIOptions =>
	({
		providerOptions: { openai: { reasoningSummary: "auto" } },
		...input.options,
		...(input.thinkingLevel === undefined || input.thinkingLevel === "off" ? {} : { reasoning: input.thinkingLevel }),
		sessionId: input.sessionId,
		signal,
	}) as unknown as OpenAIOptions;

const reasonFields = (failure: AikitFailure.Failure) => ({
	message: failure.message,
	isRetryable: failure.retryable,
	...(failure.status === undefined ? {} : { status: failure.status }),
	...(failure.code === undefined ? {} : { code: failure.code }),
	...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
	...(failure.retryAfterMs === undefined ? {} : { retryAfter: Duration.millis(failure.retryAfterMs) }),
});

/** Lift Aikit's JSON-safe failure data into the Effect-native Runner error channel. */
export const providerError = (
	input: Pick<Input, "provider" | "model">,
	failure: AikitFailure.Failure,
): Runner.ProviderError => {
	const fields = reasonFields(failure);
	const reason: Runner.ProviderFailureReason = (() => {
		switch (failure._tag) {
			case "Authentication":
				return new Runner.ProviderAuthenticationError({ authentication: failure.reason, ...fields });
			case "Configuration":
				return new Runner.ProviderConfigurationError(fields);
			case "Authorization":
				return new Runner.ProviderAuthorizationError(fields);
			case "ModelUnavailable":
				return new Runner.ProviderModelUnavailableError(fields);
			case "RateLimit":
				return new Runner.ProviderRateLimitError(fields);
			case "Quota":
				return new Runner.ProviderQuotaError(fields);
			case "InvalidRequest":
				return new Runner.ProviderInvalidRequestError(fields);
			case "ContentPolicy":
				return new Runner.ProviderContentPolicyError(fields);
			case "Timeout":
				return new Runner.ProviderTimeoutError(fields);
			case "Transport":
				return new Runner.ProviderTransportError(fields);
			case "Unavailable":
				return new Runner.ProviderUnavailableError(fields);
			case "InvalidResponse":
				return new Runner.ProviderInvalidResponseError(fields);
			case "Unknown":
				return new Runner.ProviderUnknownError(fields);
		}
	})();
	return new Runner.ProviderError({ provider: input.provider, model: input.model, reason });
};

const providerErrorFromUnknown = (input: Pick<Input, "provider" | "model">, cause: unknown) =>
	providerError(input, AikitFailure.normalize(cause));

const modelCatalogFailure = (
	cause: unknown,
):
	| {
			readonly path: string;
			readonly reason: "missing" | "unreadable" | "empty" | "invalid";
			readonly message: string;
	  }
	| undefined => {
	if (typeof cause !== "object" || cause === null || !("name" in cause) || cause.name !== "ModelCatalogLoadError") {
		return undefined;
	}
	if (!("data" in cause) || typeof cause.data !== "object" || cause.data === null) return undefined;
	const data = cause.data;
	if (
		!("path" in data) ||
		typeof data.path !== "string" ||
		!("message" in data) ||
		typeof data.message !== "string" ||
		!("reason" in data) ||
		(data.reason !== "missing" &&
			data.reason !== "unreadable" &&
			data.reason !== "empty" &&
			data.reason !== "invalid")
	) {
		return undefined;
	}
	return { path: data.path, reason: data.reason, message: data.message };
};

/** Read structured terminal data while remaining compatible with older Aikit messages. */
export const messageFailure = (message: Message.AssistantMessage): AikitFailure.Failure => {
	const candidate = (message as Message.AssistantMessage & { readonly failure?: unknown }).failure;
	return AikitFailure.isFailure(candidate)
		? candidate
		: AikitFailure.fromMessage(message.errorMessage ?? "The provider turn failed.");
};

/** Resolve the configured model and start aikit's provider stream. */
export const open: Open = Effect.fn("LLM.open")(function* (input, signal) {
	const model = yield* Effect.tryPromise({
		try: () => llm(input.provider, input.model),
		catch: (cause) => {
			const catalog = modelCatalogFailure(cause);
			return catalog === undefined
				? providerErrorFromUnknown(input, cause)
				: new Runner.ModelCatalogError({
						path: catalog.path,
						reason: catalog.reason,
						detail: catalog.message,
					});
		},
	});
	if (model === undefined) {
		return yield* new Runner.ModelNotFoundError({ provider: input.provider, model: input.model });
	}

	return yield* Effect.try({
		try: () => aikitStream(model, input.context, runtimeOptions(input, signal)),
		catch: (cause) => providerErrorFromUnknown(input, cause),
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
				const consume = Stream.fromAsyncIterable(iterable, (cause) => providerErrorFromUnknown(input, cause)).pipe(
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
