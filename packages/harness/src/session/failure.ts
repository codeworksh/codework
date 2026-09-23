import { Predicate, Schema } from "effect";
import { optional } from "../schema.ts";

/**
 * The public description of a failed execution.
 *
 * Open by design: `type` is a kebab-case category ending in `-error`, not a closed union.
 * A client older than the server degrades to the message instead of failing to
 * decode, and a new category is an additive change. The typed cause stays
 * server-side -- this is what crosses the wire.
 */
export const Error = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	/** Provider HTTP status, when the failure came from one. */
	status: optional(Schema.Int),
});
export type Error = typeof Error.Type;

const providerCategory = (tag: string): string => {
	switch (tag) {
		case "Runner.ProviderAuthenticationError":
			return "provider-authentication-error";
		case "Runner.ProviderAuthorizationError":
			return "provider-authorization-error";
		case "Runner.ProviderConfigurationError":
			return "provider-configuration-error";
		case "Runner.ProviderModelUnavailableError":
			return "provider-model-unavailable-error";
		case "Runner.ProviderRateLimitError":
			return "provider-rate-limit-error";
		case "Runner.ProviderQuotaError":
			return "provider-quota-error";
		case "Runner.ProviderInvalidRequestError":
			return "provider-invalid-request-error";
		case "Runner.ProviderContentPolicyError":
			return "provider-content-filter-error";
		case "Runner.ProviderTimeoutError":
			return "provider-timeout-error";
		case "Runner.ProviderTransportError":
			return "provider-transport-error";
		case "Runner.ProviderUnavailableError":
			return "provider-unavailable-error";
		case "Runner.ProviderInvalidResponseError":
			return "provider-invalid-response-error";
		default:
			return "provider-unknown-error";
	}
};

const category = (tag: string): string => {
	switch (tag) {
		case "Runner.ModelCatalogError":
			return "model-catalog-error";
		case "Runner.ModelNotFoundError":
			return "model-not-found-error";
		case "Runner.LLMStreamError":
			return "llm-stream-error";
		case "ContextDecodeError":
			return "context-decode-error";
		case "ContextEncodeError":
			return "context-encode-error";
		case "SessionNotFoundError":
			return "session-not-found-error";
		case "SessionLinkedSpaceNotFoundError":
			return "session-space-not-found-error";
		case "SettingsError":
			return "settings-error";
		case "State.SnapshotError":
			return "state-snapshot-error";
		case "Runner.SandboxDirectoryNotFoundError":
			return "sandbox-directory-not-found-error";
		case "SandboxFileSystemError":
			return "sandbox-filesystem-error";
		case "SandboxNotFoundError":
		case "SandboxDriverNotRegisteredError":
		case "SandboxUnavailError":
		case "SandboxRemovedError":
		case "SandboxProviderError":
			return "sandbox-mount-error";
		default:
			return "unknown-error";
	}
};

const message = (cause: unknown): string =>
	cause instanceof globalThis.Error ? cause.message : typeof cause === "string" ? cause : "Session execution failed";

/** Projects a typed drain failure onto the category vocabulary clients see. */
export const fromCause = (cause: unknown): Error => {
	const tag = Predicate.hasProperty(cause, "_tag") && typeof cause._tag === "string" ? cause._tag : undefined;
	if (tag === undefined) return { type: "unknown-error", message: message(cause) };
	if (tag === "Runner.ProviderError") {
		const reason: unknown = Predicate.hasProperty(cause, "reason") ? cause.reason : undefined;
		const reasonTag = Predicate.hasProperty(reason, "_tag") && typeof reason._tag === "string" ? reason._tag : "";
		const status =
			Predicate.hasProperty(reason, "status") && typeof reason.status === "number" ? reason.status : undefined;
		return {
			type: providerCategory(reasonTag),
			message: message(cause),
			...(status === undefined ? {} : { status }),
		};
	}
	return { type: category(tag), message: message(cause) };
};

export * as SessionFailure from "./failure.ts";
