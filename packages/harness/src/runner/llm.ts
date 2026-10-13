/*
 * @file Effect boundary for one aikit LLM request.
 *
 * aikit owns provider normalization and emits an AsyncIterable of canonical LLM
 * events. This module owns the lifecycle that aikit cannot see: Effect fiber
 * interruption aborts the transport, while a scoped consumer stays alive long
 * enough to publish aikit's terminal error event durably.
 */

import { stream as aikitStream, llm, type Event as AikitEvent, type Message, type Model } from "@codeworksh/aikit";
import * as AikitFailure from "@codeworksh/aikit/failure";
import { getGitHubCopilotApiKey, JsonGitHubCopilotAuthStorage } from "@codeworksh/aikit/oauth/github/copilot";
import { getOpenAICodexApiKey, JsonOpenAICodexAuthStorage } from "@codeworksh/aikit/oauth/openai/codex";
import { Cause, Data, Duration, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { ModelCatalog } from "../model/catalog.ts";
import type { SessionSchema } from "../session/schema.ts";
import { merge } from "../settings/merge.ts";
import { resolveOverrides, resolveRequest } from "../settings/resolve.ts";
import { type Block, type DeclaredModel, keyName } from "../settings/schema.ts";
import type { State } from "../state/state.ts";
import { Telemetry } from "../telemetry/telemetry.ts";
import { Attribution } from "./attribution.ts";
import { LLMEventPublisher } from "./event.ts";
import { Runner } from "./run.ts";

export interface Input {
	readonly sessionId: SessionSchema.ID;
	readonly context: Message.Context;
	readonly provider: string;
	readonly model: string;
	readonly resolvedModel: Model.Info;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly options?: State.RequestOptions;
	readonly settings?: Block;
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

export interface OpenOptions {
	/**
	 * `auth.json` holding OAuth credentials for providers that have no API key
	 * environment variable. Omitted, aikit resolves its own default location.
	 */
	readonly authFile?: string;
}

export type Request = (
	input: RequestInput,
) => Effect.Effect<
	LLMEventPublisher.Terminal,
	Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError | Runner.LLMStreamError
>;

export const runtimeOptions = (input: Input, model: Model.Info, signal: AbortSignal) => {
	const { activeTools, ...options } = merge(resolveRequest(input.settings ?? {}, model), input.options);
	return {
		...options,
		...(activeTools === undefined ? {} : { activeTools: [...activeTools] }),
		...(input.thinkingLevel === undefined || input.thinkingLevel === "off" ? {} : { reasoning: input.thinkingLevel }),
		sessionId: input.sessionId,
		signal,
	};
};

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

/** Read structured terminal data while remaining compatible with older Aikit messages. */
export const messageFailure = (message: Message.AssistantMessage): AikitFailure.Failure => {
	const candidate = (message as Message.AssistantMessage & { readonly failure?: unknown }).failure;
	return AikitFailure.isFailure(candidate)
		? candidate
		: AikitFailure.fromMessage(message.errorMessage ?? "The provider turn failed.");
};

export type ResolutionInput = Pick<Input, "provider" | "model" | "settings"> & {
	/** Catalog entries from the session's settings, which take precedence over the generated catalog. */
	readonly models?: ReadonlyArray<DeclaredModel>;
};
export type Resolve = (
	input: ResolutionInput,
) => Effect.Effect<Model.Info, Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError>;

/** Resolve once before exchange setup; execution reuses this exact instance. */
export const resolve: Resolve = Effect.fn("LLM.resolve")(function* (input) {
	const overrides = resolveOverrides(input.settings ?? {});
	const declared = ModelCatalog.entry(input.models ?? [], input.provider, input.model);
	const model =
		declared !== undefined
			? { ...declared, ...overrides }
			: yield* Effect.tryPromise({
					try: () => llm(input.provider, input.model, overrides),
					catch: (cause) => ModelCatalog.loadError(cause) ?? providerErrorFromUnknown(input, cause),
				});
	if (model === undefined) {
		return yield* new Runner.ModelNotFoundError({ provider: input.provider, model: input.model });
	}
	// `model.options.apiKey` picks the variable aikit reads the key from, by name only.
	const apiKey = input.settings?.apiKey;
	return apiKey === undefined ? model : { ...model, provider: { ...model.provider, key: keyName(apiKey) } };
});

/**
 * Fill in what an OAuth provider needs and the model catalog cannot carry: the
 * stored access token, and for Copilot the plan-specific inference host chosen
 * at login. Anything the request already pins is left alone, and a provider
 * with no stored login resolves to `{}` so aikit reports the missing key.
 */
// oxlint-disable-next-line effecttsgo/async-function -- aikit's OAuth clients are Promise-based.
const oauthCredentials = async (
	protocol: string,
	options: OpenOptions,
): Promise<{ apiKey?: string; baseURL?: string }> => {
	const storage = ModelCatalog.oauthStorage(options.authFile);

	if (protocol === "openai-codex") {
		const apiKey = await getOpenAICodexApiKey({ storage: new JsonOpenAICodexAuthStorage(storage) });
		return apiKey === undefined ? {} : { apiKey };
	}

	if (protocol === "github-copilot") {
		const store = new JsonGitHubCopilotAuthStorage(storage);
		const stored = await store.get();
		const apiKey = await getGitHubCopilotApiKey({ storage: store });
		if (apiKey === undefined) return {};
		// The plan-specific host belongs to the account the login was issued for,
		// so it only travels with that credential -- an environment token may be a
		// different account entirely, and routing it to this host would 401.
		const apiEndpoint = apiKey === stored?.access ? stored.apiEndpoint : undefined;
		return { apiKey, ...(apiEndpoint === undefined ? {} : { baseURL: apiEndpoint }) };
	}

	return {};
};

/** Start a provider stream using the model pinned by State. */
export const openWith = (options: OpenOptions = {}): Open =>
	Effect.fn("LLM.open")(function* (input, signal) {
		const model = Attribution.withAttribution(input.resolvedModel);
		const configured = runtimeOptions(input, model, signal);

		const resolved =
			configured.apiKey === undefined
				? yield* Effect.tryPromise({
						try: () => oauthCredentials(model.protocol, options),
						catch: (cause) => providerErrorFromUnknown(input, cause),
					})
				: {};
		const request = {
			...configured,
			...resolved,
			...(configured.baseURL === undefined ? {} : { baseURL: configured.baseURL }),
		};

		return yield* Effect.try({
			try: () => aikitStream(model, input.context, request),
			catch: (cause) => providerErrorFromUnknown(input, cause),
		});
	});

export const open: Open = openWith();

const isProviderError = Schema.is(Runner.ProviderError);

/** `error.type` for a request: the provider's failure reason, so a terminal and a thrown failure agree. */
const requestErrorType = (input: RequestInput, exit: Exit.Exit<LLMEventPublisher.Terminal, unknown>) => {
	if (Exit.isFailure(exit)) {
		const error = Cause.squash(exit.cause);
		return isProviderError(error) ? error.reason._tag : Telemetry.errorType(exit.cause);
	}
	if (exit.value.outcome === "ended") return undefined;
	if (exit.value.reason === "aborted") return "aborted";
	return providerError(input, messageFailure(exit.value.message)).reason._tag;
};

const observe = Effect.fnUntraced(function* (
	input: RequestInput,
	timing: { readonly start: number; readonly firstToken: number | undefined },
	exit: Exit.Exit<LLMEventPublisher.Terminal, unknown>,
	// An interrupted request still drains aikit's terminal, which carries the usage it spent.
	drained: LLMEventPublisher.Terminal | undefined,
) {
	const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
	const labels = { provider: input.provider, model: input.model };
	const errorType = requestErrorType(input, exit);
	yield* Telemetry.record(
		Telemetry.llmDuration,
		(now - timing.start) / 1000,
		errorType === undefined ? labels : { ...labels, error: errorType },
	);
	if (timing.firstToken !== undefined) {
		const ttft = (timing.firstToken - timing.start) / 1000;
		yield* Telemetry.record(Telemetry.llmTtft, ttft, labels);
		yield* Effect.annotateCurrentSpan("gen_ai.response.time_to_first_chunk", ttft);
	}
	if (errorType !== undefined) yield* Effect.annotateCurrentSpan("error.type", errorType);
	const terminal = Exit.isSuccess(exit) ? exit.value : drained;
	if (terminal === undefined) return;

	const { message } = terminal;
	const { usage } = message;
	// aikit's `input` excludes cached tokens; input counts them, as the GenAI conventions do.
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const tokens = {
		input: inputTokens,
		output: usage.output,
		cache_read: usage.cacheRead,
		cache_write: usage.cacheWrite,
		reasoning: usage.reasoning ?? 0,
	};
	for (const [type, count] of Object.entries(tokens)) {
		if (count > 0) yield* Telemetry.record(Telemetry.llmTokens, count, { ...labels, type });
	}
	if (usage.cost.total > 0) yield* Telemetry.record(Telemetry.llmCost, usage.cost.total, labels);
	yield* Effect.annotateCurrentSpan({
		"gen_ai.response.model": message.responseModel ?? message.model,
		...(message.responseId === undefined ? {} : { "gen_ai.response.id": message.responseId }),
		"gen_ai.response.finish_reasons": [terminal.reason],
		"gen_ai.usage.input_tokens": inputTokens,
		"gen_ai.usage.output_tokens": usage.output,
		"gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
		"gen_ai.usage.cache_write.input_tokens": usage.cacheWrite,
		...(usage.reasoning === undefined ? {} : { "gen_ai.usage.reasoning.output_tokens": usage.reasoning }),
	});
});

// aikit pushes `start` and block starts before any content, so the first token is the first delta.
const isToken = (event: AikitEvent.LLMMessageEvent) =>
	event.type === "text.delta" || event.type === "thinking.delta" || event.type === "toolcall.delta";

/**
 * A failed terminal is the request's result, not an error. It leaves the
 * traced request as a failure so the span records an error status, and is
 * recovered just outside it.
 */
class FailedTerminal extends Data.TaggedError("LLM.FailedTerminal")<{
	readonly terminal: LLMEventPublisher.Terminal;
}> {}

/**
 * Build a provider request from an opener. Tests use this with deterministic
 * aikit event streams; production uses `open` above.
 */
export const make = (openStream: Open): Request => {
	const request = Effect.fn("LLM.run", { kind: "client", level: "Info" })(function* (input: RequestInput) {
		yield* Effect.annotateCurrentSpan({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": input.provider,
			"gen_ai.request.model": input.model,
			"gen_ai.conversation.id": input.sessionId,
			"gen_ai.request.stream": true,
		});
		const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		let firstToken: number | undefined;
		let drained: LLMEventPublisher.Terminal | undefined;
		const markToken = (event: AikitEvent.LLMMessageEvent) =>
			firstToken !== undefined || !isToken(event)
				? Effect.void
				: Effect.clockWith((clock) =>
						Effect.sync(() => {
							firstToken = clock.currentTimeMillisUnsafe();
						}),
					);

		/*
		 * Give the transport signal its own closeable scope. Closing it aborts the
		 * signal immediately without closing this request's outer scope, which must
		 * remain alive while the consumer drains and commits aikit's terminal event.
		 */
		const signalScope = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(signalScope, exit));
		const signal = yield* Effect.abortSignal.pipe(Scope.provide(signalScope));
		const abort = Scope.close(signalScope, Exit.void);

		const settled = Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const iterable = yield* restore(openStream(input, signal)).pipe(Effect.onInterrupt(() => abort));
				const consume = Stream.fromAsyncIterable(iterable, (cause) => providerErrorFromUnknown(input, cause)).pipe(
					Stream.runForEach((event) => Effect.andThen(markToken(event), input.publisher.publish(event))),
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
					const consumed = yield* Fiber.await(consumer);
					if (Exit.isFailure(consumed)) return yield* Effect.failCause(consumed.cause);
					drained = consumed.value;
					return yield* Effect.failCause(awaited.cause);
				}

				const completed = awaited.value;
				if (Exit.isFailure(completed)) return yield* Effect.failCause(completed.cause);
				return completed.value;
			}),
		);
		const terminal = yield* settled.pipe(
			Effect.onExit((exit) => observe(input, { start, firstToken }, exit, drained)),
		);
		if (terminal.outcome === "failed") return yield* new FailedTerminal({ terminal });
		return terminal;
	});

	return (input) =>
		request(input).pipe(
			Effect.catchTag("LLM.FailedTerminal", (failed) => Effect.succeed(failed.terminal)),
			Effect.scoped,
		);
};

export const run = make(open);

export * as LLM from "./llm.ts";
