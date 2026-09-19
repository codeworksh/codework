import { Plugin, Runner, SandboxError, Settings } from "@codeworksh/harness/effect";
import { SandboxProvider } from "@codeworksh/harness/sandbox";
import { Duration, Effect, Schema } from "effect";
import { Client } from "../server/client.ts";
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
const isPluginSourceError = Schema.is(Plugin.SourceError);
const isPluginStoreError = Schema.is(Plugin.StoreError);
const isSettingsError = Schema.is(Settings.SettingsError);
const isSandboxDriverNotRegisteredError = Schema.is(SandboxError.SandboxDriverNotRegisteredError);
const isSandboxDriverRegistrationError = Schema.is(SandboxError.SandboxDriverRegistrationError);
const isExecutionError = Schema.is(Client.ExecutionError);

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
	}
};

/** One hint per reason. Lowercase, like everything else a plugin failure prints. */
const pluginReasonHint = (
	reason: Plugin.SourceError["reason"] | Plugin.InstallError["reason"] | Plugin.StoreError["reason"],
): string => {
	switch (reason) {
		case "plugin-unsupported-source":
			return "a path entry starts with `./`, `../`, `~/` or `/`; anything else is a package or a git spec, and a remote tarball is not supported";
		case "plugin-not-found":
			return "the path does not exist; check the spelling, remembering it anchors to the settings file that declares it";
		case "plugin-escapes-root":
			return "a plugin path must stay inside the project it is declared in";
		case "plugin-resolve-failed":
			return "check that the registry or git remote is reachable, and that your credentials are current";
		case "plugin-fetch-failed":
			return "check the package name and version, and that the registry is reachable";
		case "plugin-no-commit":
			return "the git source installed but no commit could be recovered; name a branch, tag or commit explicitly";
		case "plugin-no-entrypoint":
			return "the package installed but exports no module to import; check its `exports` and `main`";
		case "plugin-not-installed":
			return "run `codework plugin install` to fetch what the settings files name";
		case "plugin-lock-timeout":
			return "another install is holding this entry; wait for it to finish, or remove the stale `.lock` directory";
		case "plugin-marker-invalid":
		case "plugin-index-invalid":
			return "the store entry is damaged; remove it and install again";
		case "plugin-collect-failed":
			return "the store could not be tidied; check the permissions on the plugin cache";
	}
};

const settingsHint = (reason: Settings.SettingsError["reason"]): string => {
	switch (reason) {
		case "read":
			return "the file exists but could not be read; check that it is a file and readable";
		case "parse":
			return "the file is not valid JSON; the location above is where parsing stopped";
		case "decode":
			return "the key above holds a value this setting does not accept";
	}
};

/** Render typed SDK errors for humans without exposing Effect causes or provider payloads. */
export const renderError = (error: unknown): string => {
	if (isSandboxDriverNotRegisteredError(error)) {
		return `error: sandbox driver "${error.driver}" is not registered (available: ${error.registered?.join(", ") ?? "none"})\n`;
	}
	if (isSandboxDriverRegistrationError(error)) {
		return `error: ${error.reason}\n`;
	}
	if (isInvalidInputError(error)) {
		return `error: ${error.message}\n`;
	}
	if (isModelgenError(error)) {
		return (
			["error[model-catalog]: failed to generate the model catalog", "hint: check the output path and retry"].join(
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
	if (isSettingsError(error)) {
		return (
			[
				`error[settings]: ${error.path}`,
				`reason: ${error.reason}`,
				`detail: ${error.detail}`,
				`hint: ${settingsHint(error.reason)}`,
			].join("\n") + "\n"
		);
	}
	// One shape for all three plugin domains: the reason is the slug, the message is the sentence,
	// and the reference is the string the person recognises from their settings file.
	if (isPluginSourceError(error) || isPluginInstallError(error) || isPluginStoreError(error)) {
		return (
			[
				`error[${error.reason}]: ${error.message}`,
				...(error.reference === "" ? [] : [`reference: ${error.reference}`]),
				`hint: ${pluginReasonHint(error.reason)}`,
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
				`error[model-catalog]: ${error.message}`,
				"hint: run `codework models generate` or set CODEWORK_MODELS_FILE to a generated catalog",
			].join("\n") + "\n"
		);
	}
	if (isModelNotFoundError(error)) {
		return (
			[
				`error[model-not-found]: ${error.message}`,
				"hint: check the provider/model IDs in models.gen.json or regenerate the catalog",
			].join("\n") + "\n"
		);
	}
	if (isLLMStreamError(error)) {
		return `error[stream]: ${error.message}\n`;
	}
	// A remote run has only the category the server published; render it the same
	// way a local typed error is rendered, minus the detail that stayed server-side.
	if (isExecutionError(error)) {
		return (
			[
				error.type === "aborted" ? `error: ${error.message}` : `error[${error.type}]: ${error.message}`,
				...(error.status === undefined ? [] : [`status: ${error.status}`]),
			].join("\n") + "\n"
		);
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
