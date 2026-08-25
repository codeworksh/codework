/*
 * @file Defines API for actual run implementation (contract)
 * Typically drain wraps the run to be then drained by the coordinator.
 */

import { Context, Effect, Schema } from "effect";
import type { ContextDecodeError, ContextEncodeError } from "../context/errors.ts";
import { Location } from "../location/location.ts";
import type { SandboxMountError } from "../sandbox/errors.ts";
import { SandboxFileSystem } from "../sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { optional } from "../schema.ts";
import type { ID as SessionId } from "../session/schema.ts";
import type { SessionNotFoundError } from "../session/session.ts";
import type { State } from "../state/state.ts";

export class SandboxDirectoryNotFoundError extends Schema.TaggedError<SandboxDirectoryNotFoundError>()(
	"Runner.SandboxDirectoryNotFoundError",
	{
		sessionId: Schema.String,
		sandboxInstanceId: SandboxInstance.ID,
		directory: Schema.String,
	},
) {
	override get message(): string {
		return `sandbox directory not found: ${this.directory}`;
	}
}

const ProviderFailureFields = {
	message: Schema.String,
	isRetryable: Schema.Boolean,
	status: optional(Schema.Finite),
	code: optional(Schema.String),
	requestId: optional(Schema.String),
	retryAfter: optional(Schema.Duration),
};

export class ProviderAuthenticationError extends Schema.TaggedError<ProviderAuthenticationError>()(
	"Runner.ProviderAuthenticationError",
	{
		authentication: Schema.Literals(["missing", "invalid", "expired"]),
		...ProviderFailureFields,
	},
) {}

export class ProviderConfigurationError extends Schema.TaggedError<ProviderConfigurationError>()(
	"Runner.ProviderConfigurationError",
	ProviderFailureFields,
) {}

export class ProviderAuthorizationError extends Schema.TaggedError<ProviderAuthorizationError>()(
	"Runner.ProviderAuthorizationError",
	ProviderFailureFields,
) {}

export class ProviderModelUnavailableError extends Schema.TaggedError<ProviderModelUnavailableError>()(
	"Runner.ProviderModelUnavailableError",
	ProviderFailureFields,
) {}

export class ProviderRateLimitError extends Schema.TaggedError<ProviderRateLimitError>()(
	"Runner.ProviderRateLimitError",
	ProviderFailureFields,
) {}

export class ProviderQuotaError extends Schema.TaggedError<ProviderQuotaError>()(
	"Runner.ProviderQuotaError",
	ProviderFailureFields,
) {}

export class ProviderInvalidRequestError extends Schema.TaggedError<ProviderInvalidRequestError>()(
	"Runner.ProviderInvalidRequestError",
	ProviderFailureFields,
) {}

export class ProviderContentPolicyError extends Schema.TaggedError<ProviderContentPolicyError>()(
	"Runner.ProviderContentPolicyError",
	ProviderFailureFields,
) {}

export class ProviderTimeoutError extends Schema.TaggedError<ProviderTimeoutError>()(
	"Runner.ProviderTimeoutError",
	ProviderFailureFields,
) {}

export class ProviderTransportError extends Schema.TaggedError<ProviderTransportError>()(
	"Runner.ProviderTransportError",
	ProviderFailureFields,
) {}

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
	"Runner.ProviderUnavailableError",
	ProviderFailureFields,
) {}

export class ProviderInvalidResponseError extends Schema.TaggedError<ProviderInvalidResponseError>()(
	"Runner.ProviderInvalidResponseError",
	ProviderFailureFields,
) {}

export class ProviderUnknownError extends Schema.TaggedError<ProviderUnknownError>()(
	"Runner.ProviderUnknownError",
	ProviderFailureFields,
) {}

export const ProviderFailureReason = Schema.Union([
	ProviderAuthenticationError,
	ProviderConfigurationError,
	ProviderAuthorizationError,
	ProviderModelUnavailableError,
	ProviderRateLimitError,
	ProviderQuotaError,
	ProviderInvalidRequestError,
	ProviderContentPolicyError,
	ProviderTimeoutError,
	ProviderTransportError,
	ProviderUnavailableError,
	ProviderInvalidResponseError,
	ProviderUnknownError,
]);
export type ProviderFailureReason = Schema.Schema.Type<typeof ProviderFailureReason>;

/** Stable provider boundary for SDK and RPC consumers; inspect `reason._tag` for the category. */
export class ProviderError extends Schema.TaggedError<ProviderError>()("Runner.ProviderError", {
	provider: Schema.String,
	model: Schema.String,
	reason: ProviderFailureReason,
}) {
	override readonly cause = this.reason;

	override get message(): string {
		return `${this.provider}/${this.model}: ${this.reason.message}`;
	}

	get isRetryable(): boolean {
		return this.reason.isRetryable;
	}
}

export class ModelCatalogError extends Schema.TaggedError<ModelCatalogError>()("Runner.ModelCatalogError", {
	path: Schema.String,
	reason: Schema.Literals(["missing", "unreadable", "empty", "invalid"]),
	detail: Schema.String,
}) {
	override get message(): string {
		return this.detail;
	}
}

export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()("Runner.ModelNotFoundError", {
	provider: Schema.String,
	model: Schema.String,
}) {
	override get message(): string {
		return `model "${this.model}" is not present for provider "${this.provider}" in the model catalog`;
	}
}

export class LLMStreamError extends Schema.TaggedError<LLMStreamError>()("Runner.LLMStreamError", {
	sessionId: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `invalid provider event stream: ${this.reason}`;
	}
}

export type RunError =
	| ModelCatalogError
	| ModelNotFoundError
	| ProviderError
	| LLMStreamError
	| ContextDecodeError
	| ContextEncodeError
	| SessionNotFoundError
	| State.SnapshotError
	| SandboxDirectoryNotFoundError
	| SandboxMountError
	| SandboxFileSystem.FileSystemError;

export interface Interface {
	/** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
	readonly run: (input: {
		readonly sessionId: SessionId;
		readonly force: boolean;
	}) => Effect.Effect<void, RunError, SandboxIO.Provides | Location.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/run/Service") {}

export * as Runner from "./run.ts";
