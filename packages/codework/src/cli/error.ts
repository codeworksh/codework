import { Plugin, Runner } from "@codeworksh/harness/effect";
import { SandboxProvider } from "@codeworksh/harness/sandbox";
import { Duration, Effect, Schema } from "effect";
import { writeError } from "./output.ts";

/** Bad flag or argument combinations the parser cannot express on its own. */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("CLI.InvalidInputError", {
	message: Schema.String,
}) {}

export class ModelgenError extends Schema.TaggedError<ModelgenError>()("CLI.ModelgenError", {
	cause: Schema.Defect(),
}) {}

/**
 * Every failure a command handler may surface to the runtime. Harness failures are
 * rendered inside the handler that owns them, so only the CLI's own errors reach
 * the top-level renderer.
 */
export type CommandError = InvalidInputError | ModelgenError;

const isInvalidInputError = Schema.is(InvalidInputError);
const isModelgenError = Schema.is(ModelgenError);
const isProviderError = Schema.is(Runner.ProviderError);
const isModelCatalogError = Schema.is(Runner.ModelCatalogError);
const isModelNotFoundError = Schema.is(Runner.ModelNotFoundError);
const isLLMStreamError = Schema.is(Runner.LLMStreamError);
const isSandboxProviderError = Schema.is(SandboxProvider.SandboxProviderError);
const isPluginPreparationError = Schema.is(Plugin.PreparationError);
const isPluginInstallError = Schema.is(Plugin.InstallError);

const providerCategory = (reason: Runner.ProviderFailureReason): string => {
	switch (reason._tag) {
		case "Runner.ProviderAuthenticationError":
			return "authentication";
		case "Runner.ProviderConfigurationError":
			return "configuration";
		case "Runner.ProviderAuthorizationError":
			return "authorization";
		case "Runner.ProviderModelUnavailableError":
			return "model_unavailable";
		case "Runner.ProviderRateLimitError":
			return "rate_limited";
		case "Runner.ProviderQuotaError":
			return "quota";
		case "Runner.ProviderInvalidRequestError":
			return "invalid_request";
		case "Runner.ProviderContentPolicyError":
			return "content_policy";
		case "Runner.ProviderTimeoutError":
			return "timeout";
		case "Runner.ProviderTransportError":
			return "transport";
		case "Runner.ProviderUnavailableError":
			return "provider_unavailable";
		case "Runner.ProviderInvalidResponseError":
			return "invalid_response";
		case "Runner.ProviderUnknownError":
			return "provider";
	}
};

const credentialHint = (provider: string): string => {
	switch (provider) {
		case "openrouter":
			return "set OPENROUTER_API_KEY and retry";
		case "openai":
			return "set OPENAI_API_KEY and retry";
		case "anthropic":
			return "set ANTHROPIC_API_KEY and retry";
		case "google":
			return "set GOOGLE_GENERATIVE_AI_API_KEY and retry";
		case "xai":
			return "set XAI_API_KEY and retry";
		default:
			return `configure credentials for provider "${provider}" and retry`;
	}
};

const providerHint = (error: Runner.ProviderError): string | undefined => {
	switch (error.reason._tag) {
		case "Runner.ProviderAuthenticationError":
			return error.reason.authentication === "missing"
				? credentialHint(error.provider)
				: `check the credentials configured for provider "${error.provider}"`;
		case "Runner.ProviderAuthorizationError":
			return "check that the credential can access this model and endpoint";
		case "Runner.ProviderModelUnavailableError":
			return "check the provider model ID and whether your account can access it";
		case "Runner.ProviderRateLimitError":
			return error.reason.retryAfter === undefined
				? "retry after the provider rate-limit window resets"
				: `retry in about ${Math.ceil(Duration.toMillis(error.reason.retryAfter) / 1_000)} seconds`;
		case "Runner.ProviderQuotaError":
			return "check the provider account quota or billing balance";
		case "Runner.ProviderTimeoutError":
		case "Runner.ProviderTransportError":
		case "Runner.ProviderUnavailableError":
			return error.isRetryable ? "this failure is retryable" : undefined;
		default:
			return undefined;
	}
};

const unknownMessage = (error: unknown): string => {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	if (typeof error === "string" && error.trim().length > 0) return error;
	if (typeof error === "object" && error !== null && "_tag" in error) return String(error._tag);
	return "the command failed for an unknown reason";
};

/**
 * What the reader can do about a reference that failed to prepare. A plugin list is
 * usually hand-written in a settings file, so the phase is worth translating.
 */
const pluginHint = (phase: Plugin.PreparationError["phase"]): string => {
	switch (phase) {
		case "source":
			return "check the spelling; a path entry starts with `./`, `../`, `~/`, or `/`, and anything else is a package";
		case "install":
			return "check the package name and version, and that the registry is reachable";
		case "import":
			return "the module failed to load; import it directly to see its own error";
		case "definition":
			return "a plugin module must default-export one object with a `setup` and a `vendor.domain.name` id";
		case "resolve":
			return "the selection enables an ID that no entry defines; check for a typo or a missing source";
	}
};

/** Render typed SDK errors for humans without exposing Effect causes or provider payloads. */
export const renderError = (error: unknown): string => {
	if (isInvalidInputError(error)) {
		return `error: ${error.message}\n`;
	}
	if (isModelgenError(error)) {
		return (
			["error[model_catalog]: failed to generate the model catalog", "hint: check the output path and retry"].join(
				"\n",
			) + "\n"
		);
	}
	if (isSandboxProviderError(error)) {
		return (
			[
				`error: SandboxProviderError - ${error.sanitized.message}`,
				`driver: ${error.driver}`,
				`operation: ${error.operation}`,
				...(error.sanitized.code === undefined ? [] : [`code: ${error.sanitized.code}`]),
				...(error.stack === undefined ? [] : ["traceback:", error.stack]),
			].join("\n") + "\n"
		);
	}
	if (isPluginPreparationError(error)) {
		return (
			[
				`error[plugin]: failed to prepare plugin "${error.reference}"`,
				`phase: ${error.phase}`,
				...(error.id === undefined ? [] : [`id: ${error.id}`]),
				`detail: ${unknownMessage(error.cause)}`,
				`hint: ${pluginHint(error.phase)}`,
			].join("\n") + "\n"
		);
	}
	if (isPluginInstallError(error)) {
		return (
			[
				`error[plugin_install]: ${unknownMessage(error.cause)}`,
				"hint: check the package name and version, and that the registry is reachable",
			].join("\n") + "\n"
		);
	}
	if (isProviderError(error)) {
		const hint = providerHint(error);
		return (
			[
				`error[${providerCategory(error.reason)}]: ${error.message}`,
				`provider: ${error.provider}`,
				`model: ${error.model}`,
				...(error.reason.requestId === undefined ? [] : [`request: ${error.reason.requestId}`]),
				...(hint === undefined ? [] : [`hint: ${hint}`]),
			].join("\n") + "\n"
		);
	}
	if (isModelCatalogError(error)) {
		return (
			[
				`error[model_catalog]: ${error.message}`,
				"hint: run `codework models generate` or set CODEWORK_MODELS_FILE to a generated catalog",
			].join("\n") + "\n"
		);
	}
	if (isModelNotFoundError(error)) {
		return (
			[
				`error[model_not_found]: ${error.message}`,
				"hint: check the provider/model IDs in models.gen.json or regenerate the catalog",
			].join("\n") + "\n"
		);
	}
	if (isLLMStreamError(error)) {
		return `error[stream_protocol]: ${error.message}\n`;
	}
	return `error: ${unknownMessage(error)}\n`;
};

export const reportFailure = (error: unknown) =>
	writeError(renderError(error)).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.exitCode = 1;
			}),
		),
	);
