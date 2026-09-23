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
import { Duration, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { ModelCatalog } from "../model/catalog.ts";
import type { SessionSchema } from "../session/schema.ts";
import { merge } from "../settings/merge.ts";
import { resolveOverrides, resolveRequest } from "../settings/resolve.ts";
import type { Block } from "../settings/schema.ts";
import type { State } from "../state/state.ts";
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

export type ResolutionInput = Pick<Input, "provider" | "model" | "settings">;
export type Resolve = (
	input: ResolutionInput,
) => Effect.Effect<Model.Info, Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError>;

/** Resolve once before exchange setup; execution reuses this exact instance. */
export const resolve: Resolve = Effect.fn("LLM.resolve")(function* (input) {
	const model = yield* Effect.tryPromise({
		try: () => llm(input.provider, input.model, resolveOverrides(input.settings ?? {})),
		catch: (cause) => ModelCatalog.loadError(cause) ?? providerErrorFromUnknown(input, cause),
	});
	if (model === undefined) {
		return yield* new Runner.ModelNotFoundError({ provider: input.provider, model: input.model });
	}

	return model;
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
	const storage = options.authFile === undefined ? {} : { path: options.authFile };

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
		const model = input.resolvedModel;
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
